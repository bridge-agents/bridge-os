import { BridgeError, generateToken, hashToken, id, newWorkspaceId } from "@bridge/core";
import { users, workspaceInvitations, workspaceMembers, workspaces } from "@bridge/db";
import { isValidTimezone } from "@bridge/runtime";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody, type WorkspaceRole } from "./http.js";

export function workspaceRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps));

  app.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        timezone: workspaces.timezone,
        defaultModel: workspaces.defaultModel,
        defaultReasoning: workspaces.defaultReasoning,
        allowedPaths: workspaces.allowedPaths,
        role: workspaceMembers.role,
      })
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
    return c.json(
      { workspace: { id: workspaceId, name: body.name, timezone: null, role: "owner" } },
      201,
    );
  });

  app.get("/:workspaceId", requireWorkspace(deps), async (c) => {
    const [workspace] = await deps.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, c.get("workspaceId")));
    return c.json({ workspace: { ...workspace, role: c.get("role") } });
  });

  app.patch("/:workspaceId", requireWorkspace(deps), requireRole("owner", "admin"), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).nullable().optional(),
        /**
         * What "9am" means here. Validated against the platform's own zone
         * database rather than a list we would have to maintain — a typo
         * saved now is a schedule that fires at the wrong hour forever.
         */
        timezone: z
          .string()
          .trim()
          .max(64)
          .nullable()
          .optional()
          .refine((value) => !value || isValidTimezone(value), {
            message: "not a timezone this machine knows (use an IANA name like Europe/London)",
          }),
        /** What a run uses when nothing else says — chat, schedules, the CLI. */
        defaultModel: z
          .object({ provider: z.string().min(1), model: z.string().min(1) })
          .nullable()
          .optional(),
        defaultReasoning: z
          .enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"])
          .nullable()
          .optional(),
        /** Folders on this machine agents may work in. */
        allowedPaths: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
      }),
    );
    const [workspace] = await deps.db
      .update(workspaces)
      .set({
        name: body.name,
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone || null } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.defaultReasoning !== undefined ? { defaultReasoning: body.defaultReasoning } : {}),
        ...(body.allowedPaths !== undefined ? { allowedPaths: body.allowedPaths } : {}),
      })
      .where(eq(workspaces.id, c.get("workspaceId")))
      .returning({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        timezone: workspaces.timezone,
        defaultModel: workspaces.defaultModel,
        defaultReasoning: workspaces.defaultReasoning,
        allowedPaths: workspaces.allowedPaths,
      });
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

  app.get("/:workspaceId/invitations", requireWorkspace(deps), async (c) => {
    const invitations = await deps.db
      .select({
        id: workspaceInvitations.id,
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
        expiresAt: workspaceInvitations.expiresAt,
        acceptedAt: workspaceInvitations.acceptedAt,
        createdAt: workspaceInvitations.createdAt,
      })
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.workspaceId, c.get("workspaceId")),
          isNull(workspaceInvitations.revokedAt),
        ),
      )
      .orderBy(desc(workspaceInvitations.createdAt));
    return c.json({ invitations });
  });

  app.post(
    "/:workspaceId/invitations",
    requireWorkspace(deps),
    requireRole("owner", "admin"),
    async (c) => {
      const body = await parseBody(
        c,
        z.object({
          email: z.email().max(320),
          role: z.enum(["admin", "member"]).default("member"),
          expiresInDays: z.number().int().min(1).max(30).default(7),
        }),
      );
      const email = body.email.toLowerCase();
      const [workspace] = await deps.db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, c.get("workspaceId")));
      const [inviter] = await deps.db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, c.get("userId")));
      if (!workspace || !inviter) throw new BridgeError("not_found", "workspace not found");

      const token = generateToken();
      const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);
      const [invitation] = await deps.db
        .insert(workspaceInvitations)
        .values({
          id: id("inv"),
          workspaceId: c.get("workspaceId"),
          email,
          role: body.role,
          tokenHash: hashToken(token),
          createdBy: c.get("userId"),
          expiresAt,
        })
        .returning({
          id: workspaceInvitations.id,
          email: workspaceInvitations.email,
          role: workspaceInvitations.role,
          expiresAt: workspaceInvitations.expiresAt,
        });

      let delivery: "email" | "share-link" = "share-link";
      if (deps.sendWorkspaceInvitation) {
        await deps.sendWorkspaceInvitation({
          email,
          workspaceName: workspace.name,
          invitedBy: inviter.name ?? inviter.email,
          token,
          expiresAt,
        });
        delivery = "email";
      }
      return c.json(
        {
          invitation: {
            ...invitation,
            delivery,
            ...(delivery === "share-link" ? { token } : {}),
          },
        },
        201,
      );
    },
  );

  app.delete(
    "/:workspaceId/invitations/:invitationId",
    requireWorkspace(deps),
    requireRole("owner", "admin"),
    async (c) => {
      const [revoked] = await deps.db
        .update(workspaceInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(workspaceInvitations.id, c.req.param("invitationId")),
            eq(workspaceInvitations.workspaceId, c.get("workspaceId")),
            isNull(workspaceInvitations.revokedAt),
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (!revoked) throw new BridgeError("not_found", "invitation not found");
      return c.body(null, 204);
    },
  );

  /**
   * Adds an existing Bridge account immediately; invitations cover people who
   * have not signed up yet and use mail delivery when a hosted driver exists.
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
