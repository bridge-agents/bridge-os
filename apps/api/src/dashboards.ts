import { BridgeError } from "@bridge/core";
import { workspaceDashboards } from "@bridge/db";
import { DashboardSchema } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

export function dashboardRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const [row] = await deps.db
      .select()
      .from(workspaceDashboards)
      .where(eq(workspaceDashboards.workspaceId, c.get("workspaceId")));
    return c.json({ dashboard: row ? DashboardSchema.parse(row.document) : null });
  });

  app.put("/", requireRole("owner", "admin"), async (c) => {
    const dashboard = await parseBody(c, DashboardSchema);
    await deps.db
      .insert(workspaceDashboards)
      .values({ workspaceId: c.get("workspaceId"), document: dashboard })
      .onConflictDoUpdate({
        target: workspaceDashboards.workspaceId,
        set: { document: dashboard, updatedAt: new Date() },
      });
    return c.json({ dashboard });
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
