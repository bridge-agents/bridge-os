import { BridgeError } from "@bridge/core";
import { agents, approvals, events, runSteps, runs } from "@bridge/db";
import { getDataSource, type SourceData } from "@bridge/spec";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, requireWorkspace } from "./auth.js";
import type { AppDeps, AppEnv } from "./http.js";

/**
 * Resolves dashboard data sources.
 *
 * Aggregation happens here, in SQL, not in the browser: a dashboard asking
 * for "spend per day" must not mean shipping every run to the client and
 * summing it there (ROADMAP Phase 6 risk: data-binding performance).
 *
 * Every query filters by workspace. The source name is looked up in a closed
 * catalogue first, so an unknown or crafted name can never reach a query.
 */
const SERIES_DAYS = 14;
const ROW_LIMIT = 20;

/** Days back to now, so a chart has a bar for days with no activity. */
function emptyDays(): { label: string; value: number }[] {
  const days: { label: string; value: number }[] = [];
  for (let back = SERIES_DAYS - 1; back >= 0; back--) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - back);
    days.push({ label: date.toISOString().slice(0, 10), value: 0 });
  }
  return days;
}

/**
 * A day-bucketed sum over runs. `expression` is built here from a fixed set
 * of columns — never from anything a caller supplies.
 */
async function dailySeries(
  deps: AppDeps,
  workspaceId: string,
  expression: ReturnType<typeof sql>,
): Promise<{ label: string; value: number }[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (SERIES_DAYS - 1));

  const rows = await deps.db
    .select({
      day: sql<string>`to_char(${runs.queuedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      value: expression,
    })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), gte(runs.queuedAt, since)))
    .groupBy(sql`to_char(${runs.queuedAt} at time zone 'UTC', 'YYYY-MM-DD')`);

  const byDay = new Map(rows.map((row) => [row.day, Number(row.value ?? 0)]));
  return emptyDays().map((day) => ({ label: day.label, value: byDay.get(day.label) ?? 0 }));
}

async function scalar(build: () => Promise<{ value: unknown }[]>): Promise<number> {
  const [row] = await build();
  return Number(row?.value ?? 0);
}

export async function resolveSource(
  deps: AppDeps,
  workspaceId: string,
  name: string,
): Promise<SourceData> {
  const definition = getDataSource(name);
  if (!definition) throw new BridgeError("not_found", `unknown data source "${name}"`);

  const { unit } = definition;
  const inWorkspace = eq(runs.workspaceId, workspaceId);

  switch (name) {
    case "runs.total":
      return {
        kind: "metric",
        value: await scalar(() =>
          deps.db.select({ value: sql`count(*)` }).from(runs).where(inWorkspace),
        ),
      };

    case "runs.active":
      return {
        kind: "metric",
        value: await scalar(() =>
          deps.db
            .select({ value: sql`count(*)` })
            .from(runs)
            .where(and(inWorkspace, inArray(runs.status, ["queued", "running"]))),
        ),
      };

    case "runs.cost.total":
      return {
        kind: "metric",
        unit,
        value: await scalar(() =>
          deps.db
            .select({ value: sql`coalesce(sum(${runs.costUsd}), 0)` })
            .from(runs)
            .where(inWorkspace),
        ),
      };

    case "runs.tokens.total":
      return {
        kind: "metric",
        unit,
        value: await scalar(() =>
          deps.db
            .select({
              value: sql`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)`,
            })
            .from(runs)
            .where(inWorkspace),
        ),
      };

    case "approvals.pending.count":
      return {
        kind: "metric",
        value: await scalar(() =>
          deps.db
            .select({ value: sql`count(*)` })
            .from(approvals)
            .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, "pending"))),
        ),
      };

    case "agents.deployed.count":
      return {
        kind: "metric",
        value: await scalar(() =>
          deps.db
            .select({ value: sql`count(*)` })
            .from(agents)
            .where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, "deployed"))),
        ),
      };

    case "runs.count.daily":
      return { kind: "series", unit, points: await dailySeries(deps, workspaceId, sql`count(*)`) };

    case "runs.cost.daily":
      return {
        kind: "series",
        unit,
        points: await dailySeries(deps, workspaceId, sql`coalesce(sum(${runs.costUsd}), 0)`),
      };

    case "runs.tokens.daily":
      return {
        kind: "series",
        unit,
        points: await dailySeries(
          deps,
          workspaceId,
          sql`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)`,
        ),
      };

    case "runs.recent":
    case "runs.failed.recent": {
      const rows = await deps.db
        .select({
          id: runs.id,
          status: runs.status,
          trigger: runs.trigger,
          tokens: sql<number>`${runs.inputTokens} + ${runs.outputTokens}`,
          cost: runs.costUsd,
          queuedAt: runs.queuedAt,
        })
        .from(runs)
        .where(
          name === "runs.failed.recent" ? and(inWorkspace, eq(runs.status, "failed")) : inWorkspace,
        )
        .orderBy(desc(runs.queuedAt))
        .limit(ROW_LIMIT);

      return {
        kind: "rows",
        columns: ["run", "status", "trigger", "tokens", "cost", "started"],
        rows: rows.map((row) => [
          row.id,
          row.status,
          row.trigger,
          Number(row.tokens ?? 0),
          row.cost ? `$${Number(row.cost).toFixed(4)}` : "—",
          row.queuedAt.toISOString(),
        ]),
      };
    }

    case "agents.all": {
      const rows = await deps.db
        .select({
          name: agents.name,
          slug: agents.slug,
          status: agents.status,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(eq(agents.workspaceId, workspaceId))
        .orderBy(desc(agents.updatedAt))
        .limit(ROW_LIMIT);

      return {
        kind: "rows",
        columns: ["agent", "slug", "status", "updated"],
        rows: rows.map((row) => [row.name, row.slug, row.status, row.updatedAt.toISOString()]),
      };
    }

    case "events.recent": {
      const rows = await deps.db
        .select({ type: events.type, agentId: events.agentId, createdAt: events.createdAt })
        .from(events)
        .where(eq(events.workspaceId, workspaceId))
        .orderBy(desc(events.createdAt))
        .limit(ROW_LIMIT);

      return {
        kind: "rows",
        columns: ["event", "agent", "when"],
        rows: rows.map((row) => [row.type, row.agentId ?? "—", row.createdAt.toISOString()]),
      };
    }

    case "logs.recent": {
      // Steps carry no workspace column of their own; join through the run.
      const rows = await deps.db
        .select({
          seq: runSteps.seq,
          type: runSteps.type,
          agentName: runSteps.agentName,
          runId: runSteps.runId,
          createdAt: runSteps.createdAt,
        })
        .from(runSteps)
        .innerJoin(runs, eq(runs.id, runSteps.runId))
        .where(inWorkspace)
        .orderBy(desc(runSteps.createdAt))
        .limit(ROW_LIMIT);

      return {
        kind: "rows",
        columns: ["step", "type", "agent", "run", "when"],
        rows: rows.map((row) => [
          row.seq,
          row.type,
          row.agentName ?? "—",
          row.runId,
          row.createdAt.toISOString(),
        ]),
      };
    }

    default:
      // The catalogue knows the name but nothing here answers it yet. Say so
      // rather than inventing numbers — a dashboard that lies is worse than
      // one with a gap.
      return { kind: "unavailable", reason: `"${name}" has no data in this deployment yet` };
  }
}

export function dataRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/:source", async (c) => {
    const data = await resolveSource(deps, c.get("workspaceId"), c.req.param("source"));
    return c.json({ data });
  });

  return app;
}
