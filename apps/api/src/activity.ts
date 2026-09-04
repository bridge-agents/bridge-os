import { BridgeError } from "@bridge/core";
import { agents, approvals, runSteps, runs } from "@bridge/db";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireWorkspace } from "./auth.js";
import type { AppDeps, AppEnv } from "./http.js";

/**
 * What the system actually did.
 *
 * Phase 9's whole test is whether someone can answer "what did it do, what
 * did it call, what did it cost, why did it fail" without guessing. The
 * pieces were already being recorded — `runs` carries usage and cost,
 * `run_steps` carries an ordered trace — but nothing read them back across
 * agents, so the answer lived in the database and nowhere a person could
 * reach. These endpoints are that reading.
 */

const ListQuery = z.object({
  agentId: z.string().optional(),
  status: z
    .enum(["succeeded", "failed", "cancelled", "running", "queued", "waiting_approval"])
    .optional(),
  trigger: z.string().optional(),
  /** Hours of history to consider; the default keeps the first page fast. */
  since: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

/** Rolls a run's own columns into the shape every activity view wants. */
const runColumns = {
  id: runs.id,
  agentId: runs.agentId,
  agentName: agents.name,
  status: runs.status,
  trigger: runs.trigger,
  conversationId: runs.conversationId,
  error: runs.error,
  attempt: runs.attempt,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  costUsd: runs.costUsd,
  queuedAt: runs.queuedAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
};

export function activityRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  /**
   * Every run in the workspace, newest first.
   *
   * Keyset pagination on `queued_at` rather than an offset: runs are being
   * inserted while someone reads the list, and an offset would quietly skip
   * or repeat rows as the head shifts underneath them.
   */
  app.get("/runs", async (c) => {
    const query = ListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const workspaceId = c.get("workspaceId");
    const since = query.since ? new Date(Date.now() - query.since * 60 * 60 * 1000) : undefined;

    const rows = await deps.db
      .select(runColumns)
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          ...(query.agentId ? [eq(runs.agentId, query.agentId)] : []),
          ...(query.status ? [eq(runs.status, query.status)] : []),
          ...(query.trigger ? [eq(runs.trigger, query.trigger)] : []),
          ...(since ? [gte(runs.queuedAt, since)] : []),
          ...(query.cursor ? [sql`${runs.queuedAt} < ${new Date(query.cursor)}`] : []),
        ),
      )
      .orderBy(desc(runs.queuedAt))
      .limit(query.limit + 1);

    // One extra row is fetched purely to know whether another page exists.
    const page = rows.slice(0, query.limit);
    const nextCursor =
      rows.length > query.limit ? (page.at(-1)?.queuedAt?.toISOString() ?? null) : null;

    return c.json({ runs: page, nextCursor });
  });

  /**
   * One run, its trace, and the approvals it stopped for.
   *
   * Returned together because they are one question: a run that paused is
   * only explicable alongside the decision that released it, and fetching
   * them separately means a half-drawn answer while the second request runs.
   */
  app.get("/runs/:runId/activity", async (c) => {
    const workspaceId = c.get("workspaceId");
    const runId = c.req.param("runId");

    const [run] = await deps.db
      .select(runColumns)
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.id, runId)));
    if (!run) throw new BridgeError("not_found", "run not found");

    const [steps, decisions] = await Promise.all([
      deps.db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq)),
      deps.db
        .select({
          id: approvals.id,
          toolName: approvals.toolName,
          action: approvals.action,
          status: approvals.status,
          reason: approvals.reason,
          createdAt: approvals.createdAt,
          decidedAt: approvals.decidedAt,
        })
        .from(approvals)
        .where(eq(approvals.runId, runId))
        .orderBy(asc(approvals.createdAt)),
    ]);

    return c.json({ run, steps, approvals: decisions, summary: summarise(run, steps) });
  });

  /**
   * Where the money and the failures are.
   *
   * Grouped in SQL rather than fetched and reduced here: a workspace that has
   * been running schedules for a month has far more runs than any page wants
   * to transfer, and the totals are the only part anybody reads.
   */
  app.get("/usage", async (c) => {
    const workspaceId = c.get("workspaceId");
    const days = Number(c.req.query("days") ?? 30);
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * 86_400_000);
    const scope = and(eq(runs.workspaceId, workspaceId), gte(runs.queuedAt, since));

    const [totals] = await deps.db
      .select({
        runs: count(),
        inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}), 0)::bigint`,
        costUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        succeeded: sql<number>`count(*) filter (where ${runs.status} = 'succeeded')::int`,
        /** Wall-clock seconds from claim to finish, for finished runs only. */
        medianSeconds: sql<number>`coalesce(
          percentile_cont(0.5) within group (
            order by extract(epoch from (${runs.finishedAt} - ${runs.startedAt}))
          ) filter (where ${runs.finishedAt} is not null and ${runs.startedAt} is not null),
        0)::float`,
      })
      .from(runs)
      .where(scope);

    const byAgent = await deps.db
      .select({
        agentId: runs.agentId,
        agentName: agents.name,
        runs: count(),
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        inputTokens: sql<number>`coalesce(sum(${runs.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`coalesce(sum(${runs.outputTokens}), 0)::bigint`,
        costUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
      })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(scope)
      .groupBy(runs.agentId, agents.name)
      .orderBy(desc(sql`coalesce(sum(${runs.costUsd}), 0)`));

    const daily = await deps.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${runs.queuedAt}), 'YYYY-MM-DD')`,
        runs: count(),
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
        costUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
      })
      .from(runs)
      .where(scope)
      .groupBy(sql`date_trunc('day', ${runs.queuedAt})`)
      .orderBy(asc(sql`date_trunc('day', ${runs.queuedAt})`));

    return c.json({ since: since.toISOString(), totals, byAgent, daily });
  });

  /** Approval history — every decision, not just the ones still pending. */
  app.get("/approvals/history", async (c) => {
    const rows = await deps.db
      .select({
        id: approvals.id,
        runId: approvals.runId,
        agentId: approvals.agentId,
        agentName: agents.name,
        toolName: approvals.toolName,
        action: approvals.action,
        status: approvals.status,
        reason: approvals.reason,
        createdAt: approvals.createdAt,
        decidedAt: approvals.decidedAt,
      })
      .from(approvals)
      .leftJoin(agents, eq(agents.id, approvals.agentId))
      .where(eq(approvals.workspaceId, c.get("workspaceId")))
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return c.json({ approvals: rows });
  });

  /**
   * Is the runtime well?
   *
   * Deliberately about the last hour rather than all time: "12 failures"
   * means nothing without knowing whether they were this morning or in
   * March, and a health view that never recovers from an old outage is one
   * people learn to ignore.
   */
  app.get("/health", async (c) => {
    const workspaceId = c.get("workspaceId");
    const hourAgo = new Date(Date.now() - 3_600_000);

    const [recent] = await deps.db
      .select({
        total: count(),
        failed: sql<number>`count(*) filter (where ${runs.status} = 'failed')::int`,
      })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), gte(runs.queuedAt, hourAgo)));

    const [live] = await deps.db
      .select({
        running: sql<number>`count(*) filter (where ${runs.status} = 'running')::int`,
        queued: sql<number>`count(*) filter (where ${runs.status} = 'queued')::int`,
        waiting: sql<number>`count(*) filter (where ${runs.status} = 'waiting_approval')::int`,
        /** A queued run older than a minute means nothing is claiming work. */
        stalled: sql<number>`count(*) filter (
          where ${runs.status} = 'queued' and ${runs.queuedAt} < now() - interval '1 minute'
        )::int`,
      })
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId));

    const [deployed] = await deps.db
      .select({ count: count() })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, "deployed")));

    const failureRate = recent?.total ? (recent.failed ?? 0) / recent.total : 0;
    return c.json({
      health: {
        // Stalled work is a broken runtime; failures are a broken agent.
        state: live?.stalled ? "stalled" : failureRate > 0.25 ? "degraded" : "healthy",
        lastHour: { runs: recent?.total ?? 0, failed: recent?.failed ?? 0, failureRate },
        live,
        deployedAgents: deployed?.count ?? 0,
      },
    });
  });

  return app;
}

interface TraceStep {
  type: string;
  data: unknown;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The one-line answer to "what did it do", derived rather than stored.
 *
 * Counting from the trace keeps this honest: a summary written at run time
 * can drift from the steps it claims to describe, and the steps are what a
 * person will scroll through to check.
 */
export function summarise(
  run: { status: string; error: string | null; startedAt: Date | null; finishedAt: Date | null },
  steps: TraceStep[],
) {
  const toolCalls = steps.filter((step) => step.type === "tool_call");
  const failedCalls = toolCalls.filter(
    (step) => (step.data as { ok?: boolean } | null)?.ok === false,
  );
  const tools = [
    ...new Set(
      toolCalls
        .map((step) => (step.data as { tool?: string } | null)?.tool)
        .filter((tool): tool is string => Boolean(tool)),
    ),
  ];

  return {
    modelCalls: steps.filter((step) => step.type === "model_call").length,
    toolCalls: toolCalls.length,
    failedToolCalls: failedCalls.length,
    delegations: steps.filter((step) => step.type === "delegation").length,
    errors: steps.filter((step) => step.type === "error").length,
    tools,
    durationMs:
      run.startedAt && run.finishedAt
        ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
        : null,
  };
}
