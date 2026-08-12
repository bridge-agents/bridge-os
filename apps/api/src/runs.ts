import { BridgeError } from "@bridge/core";
import { agents, appendEvent, conversations, messages, runSteps, runs } from "@bridge/db";
import {
  compile,
  connectedProviders,
  createConversation,
  enqueueRun,
  requiredProviders,
} from "@bridge/runtime";
import { parseManifest } from "@bridge/spec";
import { and, asc, desc, eq } from "drizzle-orm";
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
    return c.json({ agent: { id: agentId, status: "deployed" } });
  });

  app.post("/agents/:agentId/stop", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    await loadAgent(workspaceId, agentId);

    await deps.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agentId));
    await appendEvent(deps.db, "agent.stopped", { workspaceId, agentId });
    return c.json({ agent: { id: agentId, status: "stopped" } });
  });

  /** Send the agent a task. Creates a conversation when none is supplied. */
  app.post("/agents/:agentId/runs", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    const agent = await loadAgent(workspaceId, agentId);
    const body = await parseBody(
      c,
      z.object({
        input: z.string().min(1).max(100_000),
        conversationId: z.string().optional(),
      }),
    );

    if (agent.status === "stopped" || agent.status === "archived") {
      throw new BridgeError("conflict", `agent is ${agent.status}; deploy it before sending work`);
    }

    let conversationId = body.conversationId;
    if (conversationId) {
      const [existing] = await deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)),
        );
      if (!existing) throw new BridgeError("not_found", "conversation not found");
    } else {
      conversationId = await createConversation(deps.db, {
        workspaceId,
        agentId,
        title: body.input.slice(0, 80),
      });
    }

    const runId = await enqueueRun(deps.db, {
      workspaceId,
      agentId,
      conversationId,
      text: body.input,
    });

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

    return c.json({ conversation, messages: history });
  });

  return app;
}
