import { BridgeError, newWorkspaceId } from "@bridge/core";
import { users, workspaceMembers, workspaces } from "@bridge/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody, type WorkspaceRole } from "./http.js";

export function workspaceRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps));

  app.get("/", async (c) => {
    const rows = await deps.db
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, c.get("userId")));
    return c.json({ workspaces: rows });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().min(1).max(120) }));
    const workspaceId = newWorkspaceId();
    await deps.db.insert(workspaces).values({ id: workspaceId, name: body.name });
    await deps.db.insert(workspaceMembers).values({
      workspaceId,
      userId: c.get("userId"),
      role: "owner" satisfies WorkspaceRole,
    });
    return c.json({ workspace: { id: workspaceId, name: body.name, role: "owner" } }, 201);
  });

  app.get("/:workspaceId", requireWorkspace(deps), async (c) => {
    const [workspace] = await deps.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, c.get("workspaceId")));
    return c.json({ workspace: { ...workspace, role: c.get("role") } });
  });

  app.get("/:workspaceId/members", requireWorkspace(deps), async (c) => {
    const members = await deps.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, c.get("workspaceId")));
    return c.json({ members });
  });

  /**
   * Adds an existing Bridge account to the workspace. Email invitations for
   * people who have not signed up yet need an outbound mail path, which
   * Community installs do not have — that lands with Bridge Cloud.
   */
  app.post(
    "/:workspaceId/members",
    requireWorkspace(deps),
    requireRole("owner", "admin"),
    async (c) => {
      const body = await parseBody(
        c,
        z.object({ email: z.email(), role: z.enum(["admin", "member"]).default("member") }),
      );

      const [user] = await deps.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email.toLowerCase()));
      if (!user) throw new BridgeError("not_found", "no Bridge account with that email");

      await deps.db
        .insert(workspaceMembers)
        .values({ workspaceId: c.get("workspaceId"), userId: user.id, role: body.role })
        .onConflictDoUpdate({
          target: [workspaceMembers.workspaceId, workspaceMembers.userId],
          set: { role: body.role },
        });
      return c.json({ member: { userId: user.id, email: body.email, role: body.role } }, 201);
    },
  );

  app.delete(
    "/:workspaceId/members/:userId",
    requireWorkspace(deps),
    requireRole("owner", "admin"),
    async (c) => {
      const target = c.req.param("userId");
      const owners = await deps.db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, c.get("workspaceId")),
            eq(workspaceMembers.role, "owner"),
          ),
        );
      // A workspace with no owner can never be administered again.
      if (owners.length === 1 && owners[0]?.userId === target) {
        throw new BridgeError("conflict", "cannot remove the last owner of a workspace");
      }

      await deps.db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, c.get("workspaceId")),
            eq(workspaceMembers.userId, target),
          ),
        );
      return c.body(null, 204);
    },
  );

  return app;
}
