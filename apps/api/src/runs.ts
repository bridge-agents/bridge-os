import { BridgeError } from "@bridge/core";
import {
  agents,
  appendEvent,
  attachments,
  conversations,
  messages,
  runSteps,
  runs,
  workspaces,
} from "@bridge/db";
import {
  AutomationRunner,
  assertGrantsSupported,
  compile,
  connectedProviders,
  createConversation,
  enqueueRun,
  requiredProviders,
  runBus,
} from "@bridge/runtime";
import { parseManifest } from "@bridge/spec";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * Run lifecycle. Starting a run only writes durable state and returns — the
 * executor picks it up, so a long agent run never blocks an HTTP request and
 * survives the API restarting (ADR-0004).
 */
export function runRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  const loadAgent = async (workspaceId: string, agentId: string) => {
    const [row] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)));
    if (!row) throw new BridgeError("not_found", "agent not found");
    return row;
  };

  app.post("/agents/:agentId/deploy", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    const agent = await loadAgent(workspaceId, agentId);

    // Compiling here means a broken agent fails at deploy, not mid-run.
    const plan = compile(parseManifest(agent.manifest));
    assertGrantsSupported(plan.tools);
    const connected = await connectedProviders(deps.db, workspaceId);
    const missing = requiredProviders(plan).filter((provider) => !connected.has(provider));
    if (missing.length > 0) {
      throw new BridgeError(
        "validation_failed",
        `connect these providers before deploying: ${missing.join(", ")}`,
        missing.map((provider) => ({ path: "models", message: `${provider} is not connected` })),
      );
    }

    await deps.db.update(agents).set({ status: "deployed" }).where(eq(agents.id, agentId));
    await appendEvent(deps.db, "agent.started", { workspaceId, agentId });

    /**
     * Project this agent's triggers now rather than waiting for the runner's
     * next reconcile. Deploying an agent with a schedule and seeing an empty
     * Automations page for the next minute reads as "it did not work".
     */
    await new AutomationRunner({ db: deps.db, logger: deps.logger })
      .sync()
      .catch((err) => deps.logger.error({ err }, "automation sync after deploy failed"));

    return c.json({ agent: { id: agentId, status: "deployed" } });
  });

  app.post("/agents/:agentId/stop", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    await loadAgent(workspaceId, agentId);

    await deps.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agentId));
    await appendEvent(deps.db, "agent.stopped", { workspaceId, agentId });

    // Its schedules stop with it, and the page should say so immediately.
    await new AutomationRunner({ db: deps.db, logger: deps.logger })
      .sync()
      .catch((err) => deps.logger.error({ err }, "automation sync after stop failed"));
    return c.json({ agent: { id: agentId, status: "stopped" } });
  });

  /** Send the agent a task. Creates a conversation when none is supplied. */
  app.post("/agents/:agentId/runs", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    const agent = await loadAgent(workspaceId, agentId);
    const body = await parseBody(
      c,
      z
        .object({
          input: z.string().max(100_000).default(""),
          conversationId: z.string().optional(),
          attachmentIds: z.array(z.string()).max(10).default([]),
          model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
          reasoningEffort: z
            .enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"])
            .optional(),
          fastMode: z.boolean().default(false),
        })
        .superRefine((value, ctx) => {
          if (!value.input.trim() && value.attachmentIds.length === 0) {
            ctx.addIssue({ code: "custom", message: "a message or attachment is required" });
          }
          if (new Set(value.attachmentIds).size !== value.attachmentIds.length) {
            ctx.addIssue({ code: "custom", path: ["attachmentIds"], message: "duplicate files" });
          }
        }),
    );

    if (agent.status === "stopped" || agent.status === "archived") {
      throw new BridgeError("conflict", `agent is ${agent.status}; deploy it before sending work`);
    }

    const limits = parseManifest(agent.manifest).runtime.limits;
    if (limits.dailyTokenBudget !== undefined || limits.dailySpendUsd !== undefined) {
      const start = new Date();
      start.setUTCHours(0, 0, 0, 0);
      const [usage] = await deps.db
        .select({
          tokens: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)`,
          spendUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
        })
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            eq(runs.agentId, agentId),
            gte(runs.queuedAt, start),
          ),
        );
      if (
        (limits.dailyTokenBudget !== undefined &&
          Number(usage?.tokens ?? 0) >= limits.dailyTokenBudget) ||
        (limits.dailySpendUsd !== undefined && Number(usage?.spendUsd ?? 0) >= limits.dailySpendUsd)
      ) {
        throw new BridgeError("conflict", "this agent has reached its daily usage budget");
      }
    }

    if (body.model) {
      const connected = await connectedProviders(deps.db, workspaceId);
      if (!connected.has(body.model.provider)) {
        throw new BridgeError(
          "validation_failed",
          `provider "${body.model.provider}" is not connected`,
        );
      }
    }

    const uploaded = body.attachmentIds.length
      ? await deps.db
          .select({
            id: attachments.id,
            name: attachments.name,
            sizeBytes: attachments.sizeBytes,
          })
          .from(attachments)
          .where(
            and(
              eq(attachments.workspaceId, workspaceId),
              inArray(attachments.id, body.attachmentIds),
              isNull(attachments.runId),
            ),
          )
      : [];
    if (uploaded.length !== body.attachmentIds.length) {
      throw new BridgeError("validation_failed", "one or more attachments are unavailable");
    }
    if (
      uploaded.reduce((total, file) => total + Number(file.sizeBytes ?? 0), 0) >
      30 * 1024 * 1024
    ) {
      throw new BridgeError(
        "validation_failed",
        "attachments for one message must total 30 MB or less",
      );
    }

    let conversationId = body.conversationId;
    if (conversationId) {
      const [existing] = await deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.agentId, agentId),
            eq(conversations.id, conversationId),
          ),
        );
      if (!existing) throw new BridgeError("not_found", "conversation not found");
    } else {
      conversationId = await createConversation(deps.db, {
        workspaceId,
        agentId,
        title: (body.input.trim() || uploaded.map((file) => file.name).join(", ")).slice(0, 80),
      });
    }

    /**
     * The caller's choice wins; otherwise the workspace default. Without
     * this, anything that does not pick a model explicitly — the CLI, a
     * channel — falls through to whatever the agent's manifest names, which
     * is how a run ends up on an endpoint nobody is running.
     */
    const [workspace] = await deps.db
      .select({
        defaultModel: workspaces.defaultModel,
        defaultReasoning: workspaces.defaultReasoning,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    const runId = await enqueueRun(deps.db, {
      workspaceId,
      agentId,
      conversationId,
      text: body.input,
      attachmentIds: body.attachmentIds,
      model: body.model ?? workspace?.defaultModel ?? undefined,
      reasoningEffort:
        body.reasoningEffort ??
        ((workspace?.defaultReasoning ?? undefined) as typeof body.reasoningEffort),
      fastMode: body.fastMode,
      status: body.attachmentIds.length ? "preparing" : "queued",
    });

    if (body.attachmentIds.length) {
      const bound = await deps.db
        .update(attachments)
        .set({ conversationId, runId })
        .where(
          and(
            eq(attachments.workspaceId, workspaceId),
            inArray(attachments.id, body.attachmentIds),
            isNull(attachments.runId),
          ),
        )
        .returning({ id: attachments.id });
      if (bound.length !== body.attachmentIds.length) {
        await deps.db
          .update(attachments)
          .set({ conversationId: null, runId: null })
          .where(eq(attachments.runId, runId));
        await deps.db.delete(runs).where(eq(runs.id, runId));
        throw new BridgeError("conflict", "an attachment was already used by another run");
      }
      await deps.db.update(runs).set({ status: "queued" }).where(eq(runs.id, runId));
      runBus.announceWork();
    }

    return c.json({ run: { id: runId, status: "queued", conversationId } }, 201);
  });

  app.get("/agents/:agentId/runs", async (c) => {
    const rows = await deps.db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        conversationId: runs.conversationId,
        inputTokens: runs.inputTokens,
        outputTokens: runs.outputTokens,
        costUsd: runs.costUsd,
        queuedAt: runs.queuedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(
        and(eq(runs.workspaceId, c.get("workspaceId")), eq(runs.agentId, c.req.param("agentId"))),
      )
      .orderBy(desc(runs.queuedAt))
      .limit(50);
    return c.json({ runs: rows });
  });

  /** A run plus its full trace — what the model did, called, and delegated. */
  app.get("/runs/:runId", async (c) => {
    const workspaceId = c.get("workspaceId");
    const runId = c.req.param("runId");

    const [run] = await deps.db
      .select()
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)));
    if (!run) throw new BridgeError("not_found", "run not found");

    const steps = await deps.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.seq));

    return c.json({ run, steps });
  });

  /**
   * Request cancellation. The executor observes the flag at its next step
   * boundary, so this is always safe to call regardless of run state.
   */
  app.post("/runs/:runId/cancel", async (c) => {
    const workspaceId = c.get("workspaceId");
    const runId = c.req.param("runId");

    const updated = await deps.db
      .update(runs)
      .set({ cancelRequested: true })
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)))
      .returning({ id: runs.id, status: runs.status });
    const run = updated[0];
    if (!run) throw new BridgeError("not_found", "run not found");

    // A run that never started can be closed out immediately.
    if (run.status === "queued") {
      await deps.db
        .update(runs)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(runs.id, runId));
    }
    return c.json({ run: { id: runId, cancelRequested: true } });
  });

  app.get("/agents/:agentId/conversations", async (c) => {
    const rows = await deps.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, c.get("workspaceId")),
          eq(conversations.agentId, c.req.param("agentId")),
        ),
      )
      .orderBy(desc(conversations.createdAt))
      .limit(50);
    return c.json({ conversations: rows });
  });

  /**
   * Recent conversations across every agent — what the sidebar's chat history
   * is. Joined to agents so the list can be grouped without N+1 lookups.
   */
  app.get("/conversations", async (c) => {
    const rows = await deps.db
      .select({
        id: conversations.id,
        title: conversations.title,
        pinned: conversations.pinned,
        agentId: conversations.agentId,
        agentName: agents.name,
        externalId: conversations.externalId,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(agents.id, conversations.agentId))
      .where(eq(conversations.workspaceId, c.get("workspaceId")))
      // Most recently spoken in, not most recently created.
      .orderBy(desc(conversations.pinned), desc(conversations.updatedAt))
      .limit(100);
    return c.json({ conversations: rows });
  });

  app.patch("/conversations/:conversationId", async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          pinned: z.boolean().optional(),
        })
        .refine((value) => value.title !== undefined || value.pinned !== undefined, {
          message: "provide a title or pinned state",
        }),
    );
    const updated = await deps.db
      .update(conversations)
      .set(body)
      .where(
        and(
          eq(conversations.workspaceId, c.get("workspaceId")),
          eq(conversations.id, c.req.param("conversationId")),
        ),
      )
      .returning({
        id: conversations.id,
        title: conversations.title,
        pinned: conversations.pinned,
      });
    if (updated.length === 0) throw new BridgeError("not_found", "conversation not found");
    return c.json({ conversation: updated[0] });
  });

  app.delete("/conversations/:conversationId", async (c) => {
    const deleted = await deps.db
      .delete(conversations)
      .where(
        and(
          eq(conversations.workspaceId, c.get("workspaceId")),
          eq(conversations.id, c.req.param("conversationId")),
        ),
      )
      .returning({ id: conversations.id });
    if (deleted.length === 0) throw new BridgeError("not_found", "conversation not found");
    return c.body(null, 204);
  });

  app.get("/conversations/:conversationId", async (c) => {
    const workspaceId = c.get("workspaceId");
    const conversationId = c.req.param("conversationId");

    const [conversation] = await deps.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)));
    if (!conversation) throw new BridgeError("not_found", "conversation not found");

    const history = await deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const files = await deps.db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        runId: attachments.runId,
        name: attachments.name,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
      })
      .from(attachments)
      .where(eq(attachments.conversationId, conversationId))
      .orderBy(asc(attachments.createdAt));

    /**
     * The conversation's runs come back with it, because messages alone
     * cannot say what happened: a run that failed or is still going has a
     * question and no answer, and without this the client cannot tell that
     * apart from a conversation nobody has replied to yet.
     */
    const activity = await deps.db
      .select({
        id: runs.id,
        status: runs.status,
        trigger: runs.trigger,
        error: runs.error,
        queuedAt: runs.queuedAt,
        finishedAt: runs.finishedAt,
      })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.conversationId, conversationId)))
      .orderBy(asc(runs.queuedAt));

    return c.json({
      conversation,
      runs: activity,
      messages: history.map((message) => ({
        ...message,
        /**
         * The fallback is for a run that never finished: its uploads are
         * bound to a message only when the turn is recorded, and until then
         * they belong to the question. It is limited to the question for
         * exactly that reason — an unbound file of a live run is one the
         * user sent, not one the agent has produced.
         */
        attachments: files.filter(
          (file) =>
            file.messageId === message.id ||
            (!file.messageId && message.role === "user" && file.runId === message.runId),
        ),
      })),
    });
  });

  return app;
}
