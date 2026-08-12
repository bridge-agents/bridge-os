import {
  BridgeError,
  generateToken,
  hashPassword,
  hashToken,
  id,
  newUserId,
  newWorkspaceId,
  verifyPassword,
} from "@bridge/core";
import { type Db, sessions, users, workspaceMembers, workspaces } from "@bridge/db";
import { and, eq, gt } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  type AppDeps,
  type AppEnv,
  createRateLimiter,
  parseBody,
  type WorkspaceRole,
} from "./http.js";

const SESSION_COOKIE = "bridge_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CredentialsSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(12).max(1024),
  name: z.string().min(1).max(120).optional(),
});

/** Issue a session. Only the token hash is stored; the raw token goes to the client once. */
export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: id("ses"),
    tokenHash: hashToken(token),
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

async function resolveSession(db: Db, token: string): Promise<string | undefined> {
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row?.userId;
}

/**
 * Accepts a session cookie (browser) or a bearer token (CLI, desktop, mobile).
 * Both are the same session record, which is what keeps every client a
 * first-class user of the same public API.
 */
export function requireAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
    if (!token) throw new BridgeError("unauthorized", "authentication required");

    const userId = await resolveSession(deps.db, token);
    if (!userId) throw new BridgeError("unauthorized", "session expired or invalid");

    c.set("userId", userId);
    await next();
  };
}

/**
 * Resolves :workspaceId and proves membership. Every workspace-scoped route
 * sits behind this — it is the tenant isolation boundary, so a missing
 * membership is reported as not_found rather than forbidden to avoid
 * confirming that someone else's workspace exists.
 */
export function requireWorkspace(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) throw new BridgeError("not_found", "workspace not found");

    const [membership] = await deps.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, c.get("userId")),
        ),
      );
    if (!membership) throw new BridgeError("not_found", "workspace not found");

    c.set("workspaceId", workspaceId);
    c.set("role", membership.role as WorkspaceRole);
    await next();
  };
}

/** Restrict an action to the given workspace roles. */
export function requireRole(...allowed: WorkspaceRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!allowed.includes(c.get("role"))) {
      throw new BridgeError("forbidden", `requires role: ${allowed.join(" or ")}`);
    }
    await next();
  };
}

export function authRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  // Credential stuffing and password guessing both hit this.
  const limit = createRateLimiter(10, 60_000);

  const issueSession = async (c: Context<AppEnv>, userId: string) => {
    const { token, expiresAt } = await createSession(deps.db, userId);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.secureCookies ?? true,
      path: "/",
      expires: expiresAt,
    });
    return token;
  };

  app.post("/signup", async (c) => {
    limit(`signup:${c.req.header("x-forwarded-for") ?? "local"}`);
    const body = await parseBody(c, CredentialsSchema);
    const email = body.email.toLowerCase();

    const [existing] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (existing) throw new BridgeError("conflict", "an account with that email already exists");

    const userId = newUserId();
    const workspaceId = newWorkspaceId();
    const name = body.name?.trim() || email.split("@")[0] || "there";

    await deps.db.insert(users).values({
      id: userId,
      email,
      name,
      passwordHash: hashPassword(body.password),
    });
    // Onboarding: an account is useless without somewhere to put agents.
    await deps.db.insert(workspaces).values({ id: workspaceId, name: `${name}'s Workspace` });
    await deps.db
      .insert(workspaceMembers)
      .values({ workspaceId, userId, role: "owner" satisfies WorkspaceRole });

    const token = await issueSession(c, userId);
    return c.json(
      { user: { id: userId, email, name }, workspace: { id: workspaceId }, token },
      201,
    );
  });

  app.post("/login", async (c) => {
    const body = await parseBody(c, CredentialsSchema.pick({ email: true, password: true }));
    const email = body.email.toLowerCase();
    limit(`login:${email}`);

    const [user] = await deps.db.select().from(users).where(eq(users.email, email));
    // Same error and roughly the same work either way: don't leak which emails exist.
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      throw new BridgeError("unauthorized", "invalid email or password");
    }

    const token = await issueSession(c, user.id);
    return c.json({ user: { id: user.id, email: user.email, name: user.name }, token });
  });

  app.post("/logout", requireAuth(deps), async (c) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);
    if (token) await deps.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/me", requireAuth(deps), async (c) => {
    const [user] = await deps.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, c.get("userId")));
    if (!user) throw new BridgeError("unauthorized", "account no longer exists");
    return c.json({ user });
  });

  return app;
}
