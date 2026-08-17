import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { BridgeError, id, type Logger } from "@bridge/core";
import {
  agents,
  appendEvent,
  approvals,
  attachments,
  conversations,
  type Db,
  knowledgeNodes,
  memoryEntries,
  messages as messagesTable,
  runSteps,
  runStreamEvents,
  runs,
  workspaces,
} from "@bridge/db";
import { estimateCost } from "@bridge/providers";
import type { ChatMessage, ModelAttachment, Provider, TokenUsage, ToolArtifact } from "@bridge/sdk";
import { parseManifest } from "@bridge/spec";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { expirePendingApprovals } from "./approval-expiry.js";
import { runBus } from "./bus.js";
import { ensureCharter, readCharter } from "./charter.js";
import { compile } from "./compiler.js";
import type { ApprovalDecision, ApprovalRequest, LoopCheckpoint, RunStepRecord } from "./loop.js";
import { runAgentLoop } from "./loop.js";
import type { SecretStore } from "./secrets.js";
import type { ImageConfig, WebSearchConfig } from "./tools/native.js";
import { createRegistry } from "./tools/registry.js";
import { expandHome } from "./tools/sandbox.js";

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
  /** Bridge data root used for durable generated chat attachments. */
  attachmentDataDir?: string;
  /** Optional search backend for the web-search tool. */
  search?: WebSearchConfig;
  getSearchConfig?: (workspaceId: string) => Promise<WebSearchConfig | undefined>;
  /** Where the image tool draws; resolved from the workspace's providers. */
  image?: ImageConfig;
  getImageConfig?: (workspaceId: string) => Promise<ImageConfig | undefined>;
  /** Resolves only the named secrets each agent explicitly allows. */
  secretStore?: SecretStore;
  /** How long a dangerous action may wait for a human before it is denied. */
  approvalTtlMs?: number;
  /** Messages of a conversation replayed to the model. */
  historyTurns?: number;
  /** Of those, how many recent user turns still carry their files. */
  historyAttachmentTurns?: number;
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

interface RunInput {
  text?: string;
  attachmentIds?: string[];
  model?: { provider: string; model: string };
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  fastMode?: boolean;
}

/**
 * How much streamed text is held before it is written down. Small enough that
 * a reader reconnecting mid-run loses almost nothing, large enough that a
 * long answer is tens of rows rather than thousands.
 */
const DELTA_BATCH_CHARS = 400;
const DELTA_BATCH_MS = 250;

export class RunExecutor {
  private readonly staleAfterMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;
  private readonly dataDir: string;
  private readonly attachmentDataDir: string;
  private readonly approvalTtlMs: number;
  private readonly historyTurns: number;
  private readonly historyAttachmentTurns: number;
  private lastApprovalSweepAt = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** Guards against a bus wake-up landing on top of a tick already running. */
  private ticking = false;
  private unwatch?: () => void;

  constructor(private readonly deps: ExecutorDeps) {
    this.staleAfterMs = deps.staleAfterMs ?? 60_000;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
    this.maxAttempts = deps.maxAttempts ?? 3;
    this.dataDir = deps.dataDir ?? "./.bridge/agents";
    this.attachmentDataDir = deps.attachmentDataDir ?? deps.dataDir ?? "./.bridge";
    this.approvalTtlMs = deps.approvalTtlMs ?? 24 * 60 * 60 * 1000;
    this.historyTurns = deps.historyTurns ?? 40;
    this.historyAttachmentTurns = deps.historyAttachmentTurns ?? 2;
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
        select queued.id from runs queued
        inner join agents agent on agent.id = queued.agent_id
        where queued.status = 'queued'
          and (
            select count(*) from runs active
            where active.agent_id = queued.agent_id and active.status = 'running'
          ) < coalesce(
            nullif(agent.manifest #>> '{runtime,limits,maxConcurrentRuns}', '')::integer,
            1
          )
        order by queued.queued_at asc
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
    if (Date.now() - this.lastApprovalSweepAt >= 60_000) {
      await expirePendingApprovals(this.deps.db);
      this.lastApprovalSweepAt = Date.now();
    }
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
    let deltaWrites = Promise.resolve();
    let pendingDelta: { agentName: string; text: string } | undefined;
    let deltaTimer: NodeJS.Timeout | undefined;
    const flushDeltas = () => {
      clearTimeout(deltaTimer);
      deltaTimer = undefined;
      const batch = pendingDelta;
      pendingDelta = undefined;
      if (!batch) return;
      deltaWrites = deltaWrites
        .then(() =>
          db.insert(runStreamEvents).values({
            workspaceId: run.workspaceId,
            runId: run.id,
            type: "delta",
            data: batch,
          }),
        )
        .then(() => undefined)
        .catch((error) => logger.warn({ runId: run.id, err: error }, "delta persist failed"));
    };

    try {
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, run.agentId));
      if (!agentRow) throw new BridgeError("not_found", "agent no longer exists");

      const manifest = parseManifest(agentRow.manifest);
      const plan = compile(manifest);
      const runInput = (run.input ?? {}) as RunInput;
      const entryAgent = plan.agents[plan.entryAgent];
      if (entryAgent) {
        if (runInput.model) entryAgent.model = runInput.model;
        if (runInput.reasoningEffort) entryAgent.reasoningEffort = runInput.reasoningEffort;
        if (runInput.fastMode) entryAgent.serviceTier = "fast";
      }
      const dailyUsage = await this.dailyUsageBefore(run);

      await appendEvent(db, "run.started", {
        workspaceId: run.workspaceId,
        agentId: run.agentId,
        runId: run.id,
      });

      const history = run.conversationId ? await this.loadHistory(run.conversationId, run.id) : [];
      const input = typeof runInput.text === "string" ? runInput.text : "";
      const files = await this.loadAttachments(run.workspaceId, runInput.attachmentIds ?? []);
      const memoryKind = plan.memory?.knowledge
        ? "knowledge"
        : plan.memory?.longTerm || entryAgent?.memory?.longTerm
          ? "long-term"
          : undefined;
      const relevantMemory = memoryKind
        ? await this.loadRelevantMemory(run.workspaceId, run.agentId, input, memoryKind)
        : [];
      /**
       * The agent's own four files, read fresh each run.
       *
       * They sit above memory because they say who is speaking; memory only
       * says what it knows. Written on first run rather than at creation, so
       * agents that already existed get them too.
       */
      await ensureCharter(this.dataDir, run.workspaceId, run.agentId, manifest).catch((error) =>
        logger.warn({ agentId: run.agentId, err: error }, "could not write the agent charter"),
      );
      const charter = await readCharter(this.dataDir, run.workspaceId, run.agentId).catch(() => []);

      const conversation: ChatMessage[] = [
        ...(charter.length
          ? [
              {
                role: "system" as const,
                content: charter.map((entry) => `# ${entry.file}\n\n${entry.content}`).join("\n\n"),
              },
            ]
          : []),
        ...(relevantMemory.length
          ? [
              {
                role: "system" as const,
                content: `Relevant durable memory:\n${relevantMemory.map((entry) => `- ${entry}`).join("\n")}`,
              },
            ]
          : []),
        ...history,
        { role: "user", content: input, ...(files.length ? { attachments: files } : {}) },
      ];

      // Steps keep numbering across a pause so a resumed run has one ordered trace.
      let seq = await this.nextStepSeq(run.id);
      let costUsd = Number(run.costUsd ?? 0);
      let hasPricedStep = costUsd > 0;
      const generatedArtifacts: ToolArtifact[] = [];

      const workspaceAllowedPaths = await this.workspaceAllowedPaths(run.workspaceId);
      const allowedPaths = [...plan.sandbox.allowedPaths, ...workspaceAllowedPaths];
      const registries = new Map<string, Awaited<ReturnType<typeof createRegistry>>>();
      const search = (await this.deps.getSearchConfig?.(run.workspaceId)) ?? this.deps.search;
      const image = (await this.deps.getImageConfig?.(run.workspaceId)) ?? this.deps.image;
      /**
       * Making a picture changes nothing on your machine and nothing at the
       * other end, so it runs without asking — unless the manifest has an
       * opinion about `tool:image`, which is respected as written. Without
       * this an agent under the default "ask" policy stops for approval on
       * every drawing, which is a permission prompt for the act of replying.
       */
      if (image && !plan.permissions.rules.some((rule) => rule.resource === "tool:image")) {
        plan.permissions.rules = [
          { resource: "tool:image", actions: "*", effect: "allow" },
          ...plan.permissions.rules,
        ];
      }
      const registryFor = async (agentName: string) => {
        const existing = registries.get(agentName);
        if (existing) return existing;
        const agent = plan.agents[agentName];
        if (!agent) throw new BridgeError("internal", `unknown agent "${agentName}"`);
        const registry = await createRegistry(agent.tools, {
          workspaceId: run.workspaceId,
          agentId: run.agentId,
          /**
           * The agent's own allowed folders plus the workspace's. Machine
           * paths like "~/Downloads" do not belong in a portable manifest,
           * so the workspace is where they live — and an agent gets the
           * union, because both are things the user chose.
           */
          sandbox: { ...plan.sandbox, allowedPaths },
          dataDir: this.dataDir,
          search,
          image,
          secretStore: this.deps.secretStore,
          allowedSecrets: agent.secrets ?? [],
        });
        registries.set(agentName, registry);
        return registry;
      };

      const resume = run.checkpoint ? await this.resumeState(run) : undefined;

      const result = await runAgentLoop({
        plan,
        ...(resume ? { resume } : { messages: conversation }),
        deps: {
          getProvider: (providerId) => this.deps.getProvider(run.workspaceId, providerId),
          toolsFor: async (agentName) => {
            const agent = plan.agents[agentName];
            const registry = await registryFor(agentName);
            const tools = registry.forGrants((agent?.tools ?? []).map((grant) => grant.name));
            /**
             * Drawing is not a tool you install.
             *
             * If the workspace has a provider that can make pictures, every
             * agent can make pictures — the same way every agent can write
             * words without being granted a "writing" tool. Asking someone to
             * find and enable it, and then to approve each use, is three
             * obstacles in front of "draw me a bridge".
             */
            const drawing = image ? registry.get("image") : undefined;
            return drawing && !tools.some((tool) => tool.name === "image")
              ? [...tools, drawing]
              : tools;
          },
          context: {
            workspaceId: run.workspaceId,
            agentId: run.agentId,
            runId: run.id,
          },
          log: (message, data) => logger.debug({ runId: run.id, ...data }, message),
          /**
           * Live to whoever is watching, batched to disk.
           *
           * The bus carries every fragment the instant it exists, so nothing
           * is lost from the reader's point of view. The database only needs
           * enough to replay the run later, and a row per token was an insert
           * every few milliseconds on a database with one connection — the
           * run competing with its own transcript.
           */
          onDelta: ({ agentName, text }) => {
            runBus.publish({ type: "delta", runId: run.id, agentName, text });
            pendingDelta = { agentName, text: (pendingDelta?.text ?? "") + text };
            if (pendingDelta.text.length >= DELTA_BATCH_CHARS) flushDeltas();
            else deltaTimer ??= setTimeout(flushDeltas, DELTA_BATCH_MS);
          },
          onArtifacts: (artifacts) => generatedArtifacts.push(...artifacts),
          isCancelled: async () => {
            const [current] = await db
              .select({ cancelRequested: runs.cancelRequested })
              .from(runs)
              .where(eq(runs.id, run.id));
            return current?.cancelRequested ?? false;
          },
          isBudgetExceeded: async (usage) => {
            const tokenLimit = plan.limits.dailyTokenBudget;
            const spendLimit = plan.limits.dailySpendUsd;
            return (
              (tokenLimit !== undefined &&
                dailyUsage.tokens + usage.inputTokens + usage.outputTokens >= tokenLimit) ||
              (spendLimit !== undefined && dailyUsage.spendUsd + costUsd >= spendLimit)
            );
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
        flushDeltas();
        await deltaWrites;
        /**
         * Files this segment already produced are saved now, before the run
         * stands down. A checkpointed run resumes in a fresh process with an
         * empty artifact list, so anything not written here is lost — which
         * is what made a run that wrote two files show only the second.
         */
        if (run.conversationId) {
          await this.persistGeneratedArtifacts(
            run,
            run.conversationId,
            null,
            generatedArtifacts,
            allowedPaths,
          );
        }
        await this.pauseForApproval(run, result.checkpoint, result.request, {
          costUsd: hasPricedStep ? costUsd : undefined,
          usage: result.usage,
        });
        runBus.publish({ type: "status", runId: run.id, status: "waiting_approval" });
        logger.info({ runId: run.id, tool: result.request.toolName }, "run awaiting approval");
        return;
      }

      flushDeltas();
      const generatedAttachments = run.conversationId
        ? await this.persistTurn(run, result.content, generatedArtifacts, allowedPaths)
        : [];
      await deltaWrites;

      if (memoryKind && result.status === "succeeded" && result.content.trim()) {
        await this.rememberTurn(run, input, result.content, memoryKind);
      }

      const status = result.status === "succeeded" ? "succeeded" : statusFor(result.status);
      await db
        .update(runs)
        .set({
          status,
          output: {
            content: result.content,
            outcome: result.status,
            ...(generatedAttachments.length ? { attachments: generatedAttachments } : {}),
          },
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

  private async dailyUsageBefore(run: ClaimedRun): Promise<{ tokens: number; spendUsd: number }> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const [row] = await this.deps.db
      .select({
        tokens: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)`,
        spendUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, run.workspaceId),
          eq(runs.agentId, run.agentId),
          ne(runs.id, run.id),
          gte(runs.queuedAt, start),
        ),
      );
    return { tokens: Number(row?.tokens ?? 0), spendUsd: Number(row?.spendUsd ?? 0) };
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
      expiresAt: new Date(Date.now() + this.approvalTtlMs),
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

  /** Folders the whole workspace may work in, set once in Settings. */
  private async workspaceAllowedPaths(workspaceId: string): Promise<string[]> {
    const [row] = await this.deps.db
      .select({ allowedPaths: workspaces.allowedPaths })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.allowedPaths ?? [];
  }

  /**
   * The part of a conversation the model is shown.
   *
   * Two limits, both of which used to be missing. Only the last `historyTurns`
   * messages are replayed, because a thread does not get more useful to answer
   * from as it gets longer — it gets more expensive, slower, and eventually
   * too large to send at all. And files are attached only to the recent turns
   * that carried them: re-encoding every image in a conversation and shipping
   * it again on every single message was megabytes of upload per reply.
   */
  private async loadHistory(conversationId: string, runId: string): Promise<ChatMessage[]> {
    const recent = await this.deps.db
      .select()
      .from(messagesTable)
      // This run's own prompt is already the input; replaying it as history
      // too would show the model the same question twice.
      .where(and(eq(messagesTable.conversationId, conversationId), ne(messagesTable.runId, runId)))
      .orderBy(desc(messagesTable.createdAt))
      .limit(this.historyTurns);
    const rows = recent.reverse().filter((row) => row.role === "user" || row.role === "assistant");

    /**
     * Files come back only for the turns still in view, and only for the most
     * recent few of those: an older picture is described by the words around
     * it, and sending it again costs its full size every time.
     */
    const visible = new Set(rows.map((row) => row.id));
    const carried = rows.filter((row) => row.role === "user").slice(-this.historyAttachmentTurns);
    const eligible = new Set(carried.map((row) => row.id));

    const files = eligible.size
      ? await this.deps.db
          .select()
          .from(attachments)
          .where(eq(attachments.conversationId, conversationId))
      : [];
    const usable = files.filter(
      (file) =>
        (file.messageId && eligible.has(file.messageId)) ||
        (!file.messageId && carried.some((row) => row.runId === file.runId && visible.has(row.id))),
    );
    const hydrated = await Promise.all(
      usable.map(async (file) => ({
        messageId: file.messageId,
        runId: file.runId,
        attachment: await this.hydrateAttachment(file),
      })),
    );

    return rows.map((row) => {
      const messageFiles = hydrated
        .filter(
          (file) =>
            row.role === "user" &&
            (file.messageId === row.id || (!file.messageId && file.runId === row.runId)),
        )
        .map((file) => file.attachment);
      return {
        role: row.role as "user" | "assistant",
        content: row.content,
        ...(messageFiles.length ? { attachments: messageFiles } : {}),
      };
    });
  }

  /**
   * What the agent knows that bears on this message.
   *
   * The graph first: consolidated facts are worth more than the transcript
   * they came from, and there are far fewer of them. The raw journal is the
   * fallback for a young agent whose first consolidation has not run yet, so
   * memory is useful from the first conversation rather than the second day.
   */
  private async loadRelevantMemory(
    workspaceId: string,
    agentId: string,
    input: string,
    kind: "long-term" | "knowledge",
  ): Promise<string[]> {
    const known = await this.deps.db
      .select({
        title: knowledgeNodes.title,
        body: knowledgeNodes.body,
        confidence: knowledgeNodes.confidence,
      })
      .from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.workspaceId, workspaceId), eq(knowledgeNodes.agentId, agentId)))
      .orderBy(desc(knowledgeNodes.updatedAt))
      .limit(120);

    if (known.length > 0) {
      const terms = searchTerms(input);
      return known
        .map((node, index) => ({
          text: `${node.title}: ${node.body}`,
          score:
            overlap(terms, `${node.title} ${node.body}`) * 100 +
            Number(node.confidence ?? 0.5) * 10 -
            index,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((row) => row.text);
    }

    const rows = await this.deps.db
      .select({ content: memoryEntries.content, createdAt: memoryEntries.createdAt })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.workspaceId, workspaceId),
          eq(memoryEntries.agentId, agentId),
          eq(memoryEntries.kind, kind),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(200);

    if (kind === "long-term") return rows.slice(0, 12).map((row) => row.content);
    const terms = searchTerms(input);
    return rows
      .map((row, index) => ({
        content: row.content,
        score: overlap(terms, row.content) * 100 - index,
      }))
      .filter((row) => row.score > -12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((row) => row.content);
  }

  private async rememberTurn(
    run: ClaimedRun,
    input: string,
    output: string,
    kind: "long-term" | "knowledge",
  ): Promise<void> {
    const content = `User: ${input.trim()}\nAssistant: ${output.trim()}`.slice(0, 20_000);
    await this.deps.db.insert(memoryEntries).values({
      id: id("mem"),
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      runId: run.id,
      kind,
      content,
    });
  }

  private async loadAttachments(workspaceId: string, attachmentIds: string[]) {
    if (attachmentIds.length === 0) return [];
    const rows = await this.deps.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.workspaceId, workspaceId), inArray(attachments.id, attachmentIds)));
    return Promise.all(rows.map((row) => this.hydrateAttachment(row)));
  }

  private async hydrateAttachment(row: typeof attachments.$inferSelect): Promise<ModelAttachment> {
    const data = await readFile(row.storagePath).catch(() => {
      throw new BridgeError("not_found", `attachment "${row.name}" is unavailable`);
    });
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      dataBase64: data.toString("base64"),
    };
  }

  /** Record the answer. The question was written when the run was created. */
  private async persistTurn(
    run: ClaimedRun,
    output: string,
    generatedArtifacts: ToolArtifact[],
    allowedPaths: string[],
  ): Promise<{ id: string; name: string; mimeType: string; sizeBytes: number }[]> {
    const conversationId = run.conversationId;
    if (!conversationId) return [];

    const [userMessage] = await this.deps.db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(and(eq(messagesTable.runId, run.id), eq(messagesTable.role, "user")));

    const assistantMessageId = id("msg");
    await this.deps.db.insert(messagesTable).values({
      id: assistantMessageId,
      workspaceId: run.workspaceId,
      conversationId,
      runId: run.id,
      role: "assistant",
      content: output,
    });
    await this.deps.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    // The files that came with the question, named by the run itself.
    const uploaded = (run.input as RunInput)?.attachmentIds ?? [];
    if (userMessage && uploaded.length) {
      await this.deps.db
        .update(attachments)
        .set({ messageId: userMessage.id })
        .where(and(eq(attachments.runId, run.id), inArray(attachments.id, uploaded)));
    }

    const generated = await this.persistGeneratedArtifacts(
      run,
      conversationId,
      assistantMessageId,
      generatedArtifacts,
      allowedPaths,
    );

    /**
     * Files saved while the run was paused for an approval were written
     * before this message existed, so they carry no message of their own.
     * Everything of this run's that is still unclaimed is the agent's work,
     * because the question's own files were just bound above.
     */
    const earlier = await this.deps.db
      .update(attachments)
      .set({ messageId: assistantMessageId })
      .where(and(eq(attachments.runId, run.id), isNull(attachments.messageId)))
      .returning({
        id: attachments.id,
        name: attachments.name,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
      });

    return [...earlier, ...generated];
  }

  private async persistGeneratedArtifacts(
    run: ClaimedRun,
    conversationId: string,
    messageId: string | null,
    artifactsToSave: ToolArtifact[],
    allowedPaths: string[],
  ): Promise<{ id: string; name: string; mimeType: string; sizeBytes: number }[]> {
    const saved: { id: string; name: string; mimeType: string; sizeBytes: number }[] = [];
    let totalBytes = 0;
    const sandboxPath = resolve(this.dataDir, run.workspaceId, run.agentId);
    /**
     * Where a generated file is allowed to have come from: the agent's own
     * directory and the folders you allowed it. Anything else on disk is not
     * this run's output — a file it merely read stays where it is.
     */
    const roots = await Promise.all(
      [sandboxPath, ...allowedPaths].map(async (path) => {
        const expanded = resolve(expandHome(path));
        return realpath(expanded).catch(() => expanded);
      }),
    );
    const directory = resolve(this.attachmentDataDir, "uploads", run.workspaceId);

    /**
     * Already-saved files of this run count as seen. A run that paused for an
     * approval re-runs the call it stopped on, and the same file arriving
     * twice should not become two attachments.
     */
    const uploaded = new Set((run.input as RunInput)?.attachmentIds ?? []);
    const seen = new Set(
      (
        await this.deps.db
          .select({
            id: attachments.id,
            name: attachments.name,
            sizeBytes: attachments.sizeBytes,
          })
          .from(attachments)
          .where(eq(attachments.runId, run.id))
      )
        .filter((row) => !uploaded.has(row.id))
        .map((row) => `${row.name}:${row.sizeBytes}`),
    );

    for (const artifact of artifactsToSave) {
      let data: Buffer;
      if (artifact.sourcePath) {
        const source = resolve(artifact.sourcePath);
        if (!roots.some((root) => source === root || source.startsWith(root + sep))) continue;
        const file = await stat(source).catch(() => undefined);
        if (!file?.isFile()) continue;
        data = await readFile(source);
      } else if (artifact.dataBase64) {
        data = Buffer.from(artifact.dataBase64, "base64");
      } else {
        continue;
      }

      if (data.length === 0 || data.length > 25 * 1024 * 1024) continue;

      const name = safeArtifactName(artifact.name);
      const key = `${name}:${data.length}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (totalBytes + data.length > 30 * 1024 * 1024) break;
      totalBytes += data.length;

      const attachmentId = id("att");
      const mimeType = artifact.mimeType ?? mimeFromArtifactName(name);
      const storagePath = join(directory, attachmentId);
      await mkdir(directory, { recursive: true });
      await writeFile(storagePath, data, { flag: "wx" });
      await this.deps.db.insert(attachments).values({
        id: attachmentId,
        workspaceId: run.workspaceId,
        conversationId,
        runId: run.id,
        messageId,
        name,
        mimeType,
        sizeBytes: data.length,
        storagePath,
      });
      saved.push({ id: attachmentId, name, mimeType, sizeBytes: data.length });
    }

    return saved;
  }

  /** Poll for work until stopped. Also reclaims runs abandoned by dead workers. */
  start(pollIntervalMs = 1000): void {
    const tick = async () => {
      if (this.stopped || this.ticking) return;
      this.ticking = true;
      try {
        await this.reclaimStale();
        // Drain rather than sleeping between runs when work is queued.
        while (!this.stopped && (await this.runOnce())) {
          /* keep going */
        }
      } catch (error) {
        this.deps.logger.error({ err: error }, "executor tick failed");
      } finally {
        this.ticking = false;
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), pollIntervalMs);
    };

    /**
     * Start the moment work arrives, rather than on the next poll.
     *
     * The poll is the floor for correctness — a run queued by another process
     * is found within `pollIntervalMs` — but when the runtime shares a process
     * with the API, which is every desktop install, waiting up to a second to
     * begin is a second of somebody watching a cursor blink.
     */
    this.unwatch = runBus.onWork(() => {
      if (this.stopped || this.ticking) return;
      clearTimeout(this.timer);
      void tick();
    });
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatch?.();
    clearTimeout(this.timer);
  }
}

/** Words worth matching on: short ones match everything and mean nothing. */
function searchTerms(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3),
  );
}

const overlap = (terms: Set<string>, text: string): number => {
  const haystack = text.toLowerCase();
  let hits = 0;
  for (const term of terms) if (haystack.includes(term)) hits += 1;
  return hits;
};

function safeArtifactName(value: string): string {
  const cleaned = Array.from(value, (character) =>
    character.charCodeAt(0) < 32 || character === "/" || character === "\\" ? "_" : character,
  )
    .join("")
    .trim()
    .slice(0, 240);
  return cleaned || "generated-file";
}

function mimeFromArtifactName(name: string): string {
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[extname(name).toLowerCase()] ?? "application/octet-stream"
  );
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
    attachmentIds?: string[];
    model?: { provider: string; model: string };
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    fastMode?: boolean;
    trigger?: string;
    /** Internal staging state used while related upload rows are bound. */
    status?: "queued" | "preparing";
  },
): Promise<string> {
  const runId = id("run");
  await db.insert(runs).values({
    id: runId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    status: input.status ?? "queued",
    trigger: input.trigger ?? "manual",
    input: {
      text: input.text,
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.fastMode ? { fastMode: true } : {}),
    },
  });

  /**
   * The question is recorded now, not when the answer arrives.
   *
   * A run that fails, or is still going, used to leave its conversation
   * completely empty — so opening it showed the same blank slate as a brand
   * new chat, and a scheduled run that crashed looked like it had never
   * happened at all. What was asked is known at this moment; whether it
   * worked is not.
   */
  if (input.conversationId) {
    await db.insert(messagesTable).values({
      id: id("msg"),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId,
      role: "user",
      content: input.text,
    });
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));
  }

  // A run staged for uploads is not ready to claim; the caller rings the bell
  // once it flips to queued.
  if ((input.status ?? "queued") === "queued") runBus.announceWork();
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
