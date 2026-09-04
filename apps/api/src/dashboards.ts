import { BridgeError } from "@bridge/core";
import { workspaceDashboards } from "@bridge/db";
import { type Dashboard, DashboardSchema } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * The workspace's dashboards.
 *
 * One row per workspace still, holding a list rather than a single document.
 * That avoids a table migration for what is a change of contents, and it lets
 * a row written by the previous version read back without ceremony: a stored
 * object simply becomes a list of one.
 */
const DashboardListSchema = z.array(DashboardSchema);

export function readDashboards(document: unknown): Dashboard[] {
  const list = DashboardListSchema.safeParse(document);
  if (list.success) return list.data;

  const single = DashboardSchema.safeParse(document);
  return single.success ? [single.data] : [];
}

export function dashboardRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const [row] = await deps.db
      .select()
      .from(workspaceDashboards)
      .where(eq(workspaceDashboards.workspaceId, c.get("workspaceId")));
    const dashboards = row ? readDashboards(row.document) : [];
    // `dashboard` stays in the response so an older client keeps working.
    return c.json({ dashboards, dashboard: dashboards[0] ?? null });
  });

  app.put("/", requireRole("owner", "admin"), async (c) => {
    /**
     * Accepts a list, or a single dashboard from a client that predates them.
     * Rejecting the old shape would break a desktop window that had not yet
     * been updated alongside its server.
     */
    const body = await parseBody(c, z.union([DashboardListSchema, DashboardSchema]));
    const dashboards = Array.isArray(body) ? body : [body];

    const duplicate = dashboards
      .map((dashboard) => dashboard.id)
      .filter((id): id is string => Boolean(id))
      .find((id, index, all) => all.indexOf(id) !== index);
    if (duplicate) {
      throw new BridgeError("validation_failed", `two dashboards share the id "${duplicate}"`);
    }

    await deps.db
      .insert(workspaceDashboards)
      .values({ workspaceId: c.get("workspaceId"), document: dashboards })
      .onConflictDoUpdate({
        target: workspaceDashboards.workspaceId,
        set: { document: dashboards, updatedAt: new Date() },
      });
    return c.json({ dashboards, dashboard: dashboards[0] ?? null });
  });

  app.delete("/", requireRole("owner", "admin"), async (c) => {
    const [deleted] = await deps.db
      .delete(workspaceDashboards)
      .where(eq(workspaceDashboards.workspaceId, c.get("workspaceId")))
      .returning({ workspaceId: workspaceDashboards.workspaceId });
    if (!deleted) throw new BridgeError("not_found", "workspace dashboard not found");
    return c.body(null, 204);
  });

  return app;
}
