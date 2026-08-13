import { BridgeError, id, type Logger } from "@bridge/core";
import {
  agents,
  appendEvent,
  approvals,
  conversations,
  type Db,
  messages as messagesTable,
  runSteps,
  runs,
} from "@bridge/db";
import { estimateCost } from "@bridge/providers";
import type { ChatMessage, Provider, TokenUsage } from "@bridge/sdk";
import { parseManifest } from "@bridge/spec";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { runBus } from "./bus.js";
import { compile } from "./compiler.js";
import type { ApprovalDecision, ApprovalRequest, LoopCheckpoint, RunStepRecord } from "./loop.js";
import { runAgentLoop } from "./loop.js";
import type { WebSearchConfig } from "./tools/native.js";
import { createRegistry } from "./tools/registry.js";

/**
 * Executes runs claimed from the database.
 *
 * The database is the queue: a run is durable state before anything starts, is
 * claimed atomically, and is reclaimed if the worker holding it stops
 * heartbeating. That is what makes a killed worker recoverable, and it works
 * identically on a laptop and on a fleet — no Redis required (ADR-0010).
 */
export interface ExecutorDeps {
  db: Db;
  logger: Logger;
  /** Resolves a provider adapter with workspace credentials attached. */
  getProvider(workspaceId: string, providerId: string): Promise<Provider>;
  /** How long a run may go without a heartbeat before it is reclaimed. */
  staleAfterMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
  /** Where per-agent sandbox workspaces live. */
  dataDir?: string;
  /** Optional search backend for the web-search tool. */
  search?: WebSearchConfig;
}

interface ClaimedRun {
  id: string;
  workspaceId: string;
  agentId: string;
  conversationId: string | null;
  input: unknown;
  attempt: number;
  checkpoint: unknown;
  costUsd: string | null;
}

export class RunExecutor {
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;
  private readonly dataDir: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly deps: ExecutorDeps) {
    this.staleAfterMs = deps.staleAfterMs ?? 60_000;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.dataDir = deps.dataDir ?? "./.bridge/agents";
  }

  /**
   * Atomically take the oldest queued run. `SKIP LOCKED` lets several workers
   * poll the same table without handing the same run to two of them.
   */
  private async claim(): Promise<ClaimedRun | undefined> {
    const claimed = await this.deps.db.execute<{
      id: string;
      workspace_id: string;
      agent_id: string;
      conversation_id: string | null;
      input: unknown;
      attempt: number;
      checkpoint: unknown;
      cost_usd: string | null;
    }>(sql`
      update runs set
        status = 'running',
        started_at = coalesce(started_at, now()),
        heartbeat_at = now(),
        attempt = attempt + 1
      where id = (
        select id from runs
        where status = 'queued'
        order by queued_at asc
        limit 1
        for update skip locked
      )
      returning id, workspace_id, agent_id, conversation_id, input, attempt, checkpoint, cost_usd
    `);

    const rows = Array.isArray(claimed) ? claimed : ((claimed as { rows?: unknown[] }).rows ?? []);
    const row = rows[0] as
      | {
          id: string;
          workspace_id: string;
          agent_id: string;
          conversation_id: string | null;
          input: unknown;
          attempt: number;
          checkpoint: unknown;
          cost_usd: string | null;
        }
      | undefined;
    if (!row) return undefined;

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      input: row.input,
      attempt: Number(row.attempt),
      checkpoint: row.checkpoint,
      costUsd: row.cost_usd,
    };
  }

  /**
   * Return runs abandoned by a dead worker to the queue, or fail them once
   * they have burned through their attempts.
   */
  async reclaimStale(): Promise<number> {
    const cutoff = new Date(Date.now() - this.staleAfterMs);
    const stale = await this.deps.db
      .select({ id: runs.id, attempt: runs.attempt, workspaceId: runs.workspaceId })
      .from(runs)
      .where(
        and(eq(runs.status, "running"), or(isNull(runs.heartbeatAt), lt(runs.heartbeatAt, cutoff))),
      );

    for (const run of stale) {
      const exhausted = run.attempt >= this.maxAttempts;
      await this.deps.db
        .update(runs)
        .set(
          exhausted
            ? {
                status: "failed",
                error: `abandoned after ${run.attempt} attempts`,
                finishedAt: new Date(),
              }
            : { status: "queued", heartbeatAt: null },
        )
        .where(eq(runs.id, run.id));

      this.deps.logger.warn({ runId: run.id, attempt: run.attempt, exhausted }, "reclaimed run");
    }
    return stale.length;
  }

  /** Claim and execute a single run. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const run = await this.claim();
    if (!run) return false;
    await this.execute(run);
    return true;
  }

  private async execute(run: ClaimedRun): Promise<void> {
    const { db, logger } = this.deps;
    const heartbeat = setInterval(() => {
      void db.update(runs).set({ heartbeatAt: new Date() }).where(eq(runs.id, run.id));
    }, this.heartbeatMs);

    try {
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, run.agentId));
      if (!agentRow) throw new BridgeError("not_found", "agent no longer exists");

      const manifest = parseManifest(agentRow.manifest);
      const plan = compile(manifest);

      await appendEvent(db, "run.started", {
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        runId: run.id,
      });

      const history = run.conversationId ? await this.loadHistory(run.conversationId) : [];
      const input =
        typeof (run.input as { text?: string })?.text === "string"
          ? (run.input as { text: string }).text
          : "";
      const conversation: ChatMessage[] = [...history, { role: "user", content: input }];

      // Steps keep numbering across a pause so a resumed run has one ordered trace.
      let seq = await this.nextStepSeq(run.id);
      let costUsd = Number(run.costUsd ?? 0);
      let hasPricedStep = costUsd > 0;

      const registry = await createRegistry(plan.tools, {
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        sandbox: plan.sandbox,
        dataDir: this.dataDir,
        search: this.deps.search,
      });

      const resume = run.checkpoint ? await this.resumeState(run) : undefined;

      const result = await runAgentLoop({
        plan,
        ...(resume ? { resume } : { messages: conversation }),
        deps: {
          getProvider: (providerId) => this.deps.getProvider(run.workspaceId, providerId),
          toolsFor: (agentName) =>
            registry.forGrants((plan.agents[agentName]?.tools ?? []).map((grant) => grant.name)),
          context: {
            workspaceId: run.workspaceId,
            agentId: run.agentId,
            runId: run.id,
          },
          log: (message, data) => logger.debug({ runId: run.id, ...data }, message),
          onDelta: ({ agentName, text }) =>
            runBus.publish({ type: "delta", runId: run.id, agentName, text }),
          isCancelled: async () => {
            const [current] = await db
              .select({ cancelRequested: runs.cancelRequested })
              .from(runs)
              .where(eq(runs.id, run.id));
            return current?.cancelRequested ?? false;
          },
          deadlineAt: Date.now() + plan.limits.maxRunSeconds * 1000,
          onStep: async (step: RunStepRecord) => {
            if (step.type === "model_call") {
              const stepCost = estimateCost(step.data.model, step.usage);
              if (stepCost !== undefined) {
                costUsd += stepCost;
                hasPricedStep = true;
              }
            }
            const stepSeq = seq++;
            await db.insert(runSteps).values({
              id: id("stp"),
              workspaceId: run.workspaceId,
              runId: run.id,
              seq: stepSeq,
              type: step.type,
              agentName: step.agentName,
              data: step.data,
              inputTokens: step.type === "model_call" ? step.usage.inputTokens : 0,
              outputTokens: step.type === "model_call" ? step.usage.outputTokens : 0,
            });
            runBus.publish({
              type: "step",
              runId: run.id,
              seq: stepSeq,
              step: { type: step.type, agentName: step.agentName, data: step.data },
            });
          },
        },
      });

      // Paused for a human: persist exactly where we stopped and stand down.
      if (result.status === "waiting_approval") {
        await this.pauseForApproval(run, result.checkpoint, result.request, {
          costUsd: hasPricedStep ? costUsd : undefined,
          usage: result.usage,
        });
        runBus.publish({ type: "status", runId: run.id, status: "waiting_approval" });
        logger.info({ runId: run.id, tool: result.request.toolName }, "run awaiting approval");
        return;
      }

      if (run.conversationId) {
        await this.persistTurn(run, input, result.content);
      }

      const status = result.status === "succeeded" ? "succeeded" : statusFor(result.status);
      await db
        .update(runs)
        .set({
          status,
          output: { content: result.content, outcome: result.status },
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: hasPricedStep ? costUsd.toFixed(6) : null,
          checkpoint: null,
          finishedAt: new Date(),
        })
        .where(eq(runs.id, run.id));

      runBus.publish({ type: "status", runId: run.id, status });
      await appendEvent(db, status === "succeeded" ? "run.completed" : "run.failed", {
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        runId: run.id,
        data: { outcome: result.status },
      });

      logger.info({ runId: run.id, status, outcome: result.status }, "run finished");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      const retryable = run.attempt < this.maxAttempts;

      await db
        .update(runs)
        .set(
          retryable
            ? { status: "queued", error: message, heartbeatAt: null }
            : { status: "failed", error: message, finishedAt: new Date() },
        )
        .where(eq(runs.id, run.id));

      if (!retryable) {
        await appendEvent(db, "run.failed", {
          workspaceId: run.workspaceId,
          agentId: run.agentId,
          runId: run.id,
          data: { error: message },
        });
      }
      logger.error({ runId: run.id, err: error, retryable }, "run errored");
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Continue numbering steps after a pause instead of colliding at zero. */
  private async nextStepSeq(runId: string): Promise<number> {
    const [row] = await this.deps.db
      .select({ max: sql<number | null>`max(${runSteps.seq})` })
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
  }

  /**
   * Park the run: store the loop stack, raise an approval for a human, and
   * release the worker. Nothing is held in memory across the wait.
   */
  private async pauseForApproval(
    run: ClaimedRun,
    checkpoint: LoopCheckpoint,
    request: ApprovalRequest,
    totals: { costUsd?: number; usage: TokenUsage },
  ): Promise<void> {
    const approvalId = id("apr");
    await this.deps.db.insert(approvals).values({
      id: approvalId,
      workspaceId: run.workspaceId,
      runId: run.id,
      agentId: run.agentId,
      agentName: request.agentName,
      toolName: request.toolName,
      action: request.action,
      input: request.input,
      status: "pending",
    });

    await this.deps.db
      .update(runs)
      .set({
        status: "waiting_approval",
        checkpoint,
        inputTokens: totals.usage.inputTokens,
        outputTokens: totals.usage.outputTokens,
        costUsd: totals.costUsd === undefined ? null : totals.costUsd.toFixed(6),
        heartbeatAt: null,
      })
      .where(eq(runs.id, run.id));

    await appendEvent(this.deps.db, "approval.requested", {
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      runId: run.id,
      data: {
        approvalId,
        tool: request.toolName,
        action: request.action,
        agent: request.agentName,
      },
    });
  }

  /** Rebuild the paused loop plus the decision that released it. */
  private async resumeState(
    run: ClaimedRun,
  ): Promise<{ checkpoint: LoopCheckpoint; decision: ApprovalDecision } | undefined> {
    const [decided] = await this.deps.db
      .select()
      .from(approvals)
      .where(eq(approvals.runId, run.id))
      .orderBy(desc(approvals.createdAt))
      .limit(1);

    // A checkpoint with no decision yet means the run was requeued by a
    // reclaim; treat it as denied rather than executing without consent.
    return {
      checkpoint: run.checkpoint as LoopCheckpoint,
      decision: {
        approved: decided?.status === "approved",
        reason: decided?.reason ?? undefined,
      },
    };
  }

  private async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.deps.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId))
      .orderBy(asc(messagesTable.createdAt));

    // Only user/assistant text is replayed: instructions come from the manifest,
    // and tool traffic belongs to the run that produced it.
    return rows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => ({ role: row.role as "user" | "assistant", content: row.content }));
  }

  private async persistTurn(run: ClaimedRun, input: string, output: string): Promise<void> {
    const conversationId = run.conversationId;
    if (!conversationId) return;

    await this.deps.db.insert(messagesTable).values([
      {
        id: id("msg"),
        workspaceId: run.workspaceId,
        conversationId,
        runId: run.id,
        role: "user",
        content: input,
      },
      {
        id: id("msg"),
        workspaceId: run.workspaceId,
        conversationId,
        runId: run.id,
        role: "assistant",
        content: output,
      },
    ]);
  }

  /** Poll for work until stopped. Also reclaims runs abandoned by dead workers. */
  start(pollIntervalMs = 1000): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.reclaimStale();
        // Drain rather than sleeping between runs when work is queued.
        while (!this.stopped && (await this.runOnce())) {
          /* keep going */
        }
      } catch (error) {
        this.deps.logger.error({ err: error }, "executor tick failed");
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), pollIntervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

function statusFor(outcome: "cancelled" | "refused" | "limit_reached"): string {
  return outcome === "cancelled" ? "cancelled" : "failed";
}

/** Queue a run for an agent. The API calls this; the executor picks it up. */
export async function enqueueRun(
  db: Db,
  input: {
    workspaceId: string;
    agentId: string;
    conversationId?: string;
    text: string;
    trigger?: string;
  },
): Promise<string> {
  const runId = id("run");
  await db.insert(runs).values({
    id: runId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    status: "queued",
    trigger: input.trigger ?? "manual",
    input: { text: input.text },
  });
  return runId;
}

/** Create a conversation thread for an agent. */
export async function createConversation(
  db: Db,
  input: { workspaceId: string; agentId: string; title?: string },
): Promise<string> {
  const conversationId = id("cnv");
  await db.insert(conversations).values({
    id: conversationId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: input.title,
  });
  return conversationId;
}
