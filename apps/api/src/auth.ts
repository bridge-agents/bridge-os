import {
  BridgeError,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashPassword,
  hashToken,
  id,
  newUserId,
  newWorkspaceId,
  verifyPassword,
} from "@bridge/core";
import {
  apiTokens,
  authIdentities,
  type Db,
  oidcStates,
  sessions,
  users,
  workspaceInvitations,
  workspaceMembers,
  workspaces,
} from "@bridge/db";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as oidc from "openid-client";
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
  invitationToken: z.string().min(16).max(512).optional(),
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

async function resolveApiToken(db: Db, token: string): Promise<string | undefined> {
  if (!token.startsWith("brg_")) return undefined;
  const [row] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(token)),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    );
  if (!row) return undefined;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  return row.userId;
}

/**
 * Accepts a session cookie or bearer credentials from either a session or a
 * separately revocable `brg_` API token. Every client uses the same routes.
 */
export function requireAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : getCookie(c, SESSION_COOKIE);

    const userId = token
      ? ((await resolveSession(deps.db, token)) ?? (await resolveApiToken(deps.db, token)))
      : undefined;
    if (userId) {
      c.set("userId", userId);
      return next();
    }

    // Local desktop mode has one owner and no way to sign in as anyone else,
    // so a missing or stale token is not an error — it is the normal case.
    // A leftover token from a previous server login must not lock you out of
    // your own machine (see local.ts).
    if (deps.localUserId) {
      c.set("userId", deps.localUserId);
      return next();
    }

    throw new BridgeError(
      "unauthorized",
      token ? "session expired or invalid" : "authentication required",
    );
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
  let oidcConfig: Promise<oidc.Configuration> | undefined;
  const getOidcConfig = () => {
    if (!deps.oidc) throw new BridgeError("not_found", "company sign-in is not configured");
    oidcConfig ??= oidc.discovery(
      new URL(deps.oidc.issuer),
      deps.oidc.clientId,
      deps.oidc.clientSecret,
    );
    return oidcConfig;
  };

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
    const name = body.name?.trim() || email.split("@")[0] || "there";

    const [invitation] = body.invitationToken
      ? await deps.db
          .select()
          .from(workspaceInvitations)
          .where(
            and(
              eq(workspaceInvitations.tokenHash, hashToken(body.invitationToken)),
              eq(workspaceInvitations.email, email),
              isNull(workspaceInvitations.acceptedAt),
              isNull(workspaceInvitations.revokedAt),
              gt(workspaceInvitations.expiresAt, new Date()),
            ),
          )
      : [];
    if (body.invitationToken && !invitation) {
      throw new BridgeError(
        "validation_failed",
        "invitation is invalid, expired, or for another email",
      );
    }

    await deps.db.insert(users).values({
      id: userId,
      email,
      name,
      passwordHash: hashPassword(body.password),
    });
    let workspaceId: string;
    if (invitation) {
      workspaceId = invitation.workspaceId;
      await deps.db.insert(workspaceMembers).values({
        workspaceId,
        userId,
        role: invitation.role,
      });
      await deps.db
        .update(workspaceInvitations)
        .set({ acceptedAt: new Date() })
        .where(eq(workspaceInvitations.id, invitation.id));
    } else {
      workspaceId = newWorkspaceId();
      // Onboarding: an account is useless without somewhere to put agents.
      await deps.db.insert(workspaces).values({ id: workspaceId, name: `${name}'s Workspace` });
      await deps.db
        .insert(workspaceMembers)
        .values({ workspaceId, userId, role: "owner" satisfies WorkspaceRole });
    }

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

  app.get("/sso", (c) =>
    c.json({ sso: deps.oidc ? { enabled: true, name: deps.oidc.name } : { enabled: false } }),
  );

  app.get("/sso/start", async (c) => {
    if (!deps.oidc) throw new BridgeError("not_found", "company sign-in is not configured");
    const config = await getOidcConfig();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    await deps.db.delete(oidcStates).where(lt(oidcStates.expiresAt, new Date()));
    await deps.db.insert(oidcStates).values({
      stateHash: hashToken(state),
      encryptedPayload: encryptSecret(JSON.stringify({ verifier, nonce }), deps.secretKey),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: deps.oidc.redirectUri,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return c.redirect(url.href);
  });

  app.get("/sso/callback", async (c) => {
    if (!deps.oidc) throw new BridgeError("not_found", "company sign-in is not configured");
    const state = c.req.query("state");
    if (!state) throw new BridgeError("unauthorized", "company sign-in state is missing");
    const [stored] = await deps.db
      .delete(oidcStates)
      .where(and(eq(oidcStates.stateHash, hashToken(state)), gt(oidcStates.expiresAt, new Date())))
      .returning({ encryptedPayload: oidcStates.encryptedPayload });
    if (!stored) throw new BridgeError("unauthorized", "company sign-in state expired or invalid");
    const payload = JSON.parse(decryptSecret(stored.encryptedPayload, deps.secretKey)) as {
      verifier: string;
      nonce: string;
    };
    const tokens = await oidc.authorizationCodeGrant(await getOidcConfig(), new URL(c.req.url), {
      pkceCodeVerifier: payload.verifier,
      expectedState: state,
      expectedNonce: payload.nonce,
    });
    const claims = tokens.claims();
    const subject = typeof claims?.sub === "string" ? claims.sub : undefined;
    const email = typeof claims?.email === "string" ? claims.email.toLowerCase() : undefined;
    if (!subject || !email || claims?.email_verified === false) {
      throw new BridgeError("unauthorized", "company identity did not provide a verified email");
    }
    const domain = email.split("@").at(-1);
    if (
      deps.oidc.allowedEmailDomains?.length &&
      (!domain || !deps.oidc.allowedEmailDomains.includes(domain))
    ) {
      throw new BridgeError("forbidden", "email domain is not allowed for this Bridge server");
    }

    const [identity] = await deps.db
      .select({ userId: authIdentities.userId })
      .from(authIdentities)
      .where(
        and(eq(authIdentities.provider, deps.oidc.issuer), eq(authIdentities.subject, subject)),
      );
    const [existingUser] = identity
      ? await deps.db.select().from(users).where(eq(users.id, identity.userId))
      : await deps.db.select().from(users).where(eq(users.email, email));
    let userId = existingUser?.id;
    if (!userId) {
      userId = newUserId();
      const name = typeof claims?.name === "string" ? claims.name : email.split("@")[0];
      await deps.db.insert(users).values({ id: userId, email, name, passwordHash: null });
      const workspaceId = newWorkspaceId();
      await deps.db.insert(workspaces).values({ id: workspaceId, name: `${name}'s Workspace` });
      await deps.db.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
    }
    await deps.db
      .insert(authIdentities)
      .values({ id: id("aid"), userId, provider: deps.oidc.issuer, subject })
      .onConflictDoNothing({ target: [authIdentities.provider, authIdentities.subject] });
    await issueSession(c, userId);
    return c.redirect("/");
  });

  app.get("/tokens", requireAuth(deps), async (c) => {
    const tokens = await deps.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, c.get("userId")), isNull(apiTokens.revokedAt)));
    return c.json({ tokens });
  });

  app.post("/tokens", requireAuth(deps), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      }),
    );
    const token = `brg_${generateToken()}`;
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const [saved] = await deps.db
      .insert(apiTokens)
      .values({
        id: id("tok"),
        userId: c.get("userId"),
        name: body.name,
        tokenHash: hashToken(token),
        expiresAt,
      })
      .returning({ id: apiTokens.id, name: apiTokens.name, expiresAt: apiTokens.expiresAt });
    return c.json({ token: { ...saved, value: token } }, 201);
  });

  app.delete("/tokens/:tokenId", requireAuth(deps), async (c) => {
    const [revoked] = await deps.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, c.req.param("tokenId")),
          eq(apiTokens.userId, c.get("userId")),
          isNull(apiTokens.revokedAt),
        ),
      )
      .returning({ id: apiTokens.id });
    if (!revoked) throw new BridgeError("not_found", "API token not found");
    return c.body(null, 204);
  });

  app.post("/security/rotate-key", requireAuth(deps), async (c) => {
    if (!deps.rotateSecretKey) {
      throw new BridgeError(
        "forbidden",
        "master-key rotation must be run by the server operator for this deployment",
      );
    }
    return c.json({ rotation: await deps.rotateSecretKey() });
  });

  app.get("/invitations/:token", async (c) => {
    const [invitation] = await deps.db
      .select({
        email: workspaceInvitations.email,
        role: workspaceInvitations.role,
        expiresAt: workspaceInvitations.expiresAt,
        workspaceName: workspaces.name,
      })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvitations.workspaceId))
      .where(
        and(
          eq(workspaceInvitations.tokenHash, hashToken(c.req.param("token"))),
          isNull(workspaceInvitations.acceptedAt),
          isNull(workspaceInvitations.revokedAt),
          gt(workspaceInvitations.expiresAt, new Date()),
        ),
      );
    if (!invitation) throw new BridgeError("not_found", "invitation not found or expired");
    return c.json({ invitation });
  });

  app.post("/invitations/:token/accept", requireAuth(deps), async (c) => {
    const [user] = await deps.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, c.get("userId")));
    const [invitation] = user
      ? await deps.db
          .select()
          .from(workspaceInvitations)
          .where(
            and(
              eq(workspaceInvitations.tokenHash, hashToken(c.req.param("token"))),
              eq(workspaceInvitations.email, user.email),
              isNull(workspaceInvitations.acceptedAt),
              isNull(workspaceInvitations.revokedAt),
              gt(workspaceInvitations.expiresAt, new Date()),
            ),
          )
      : [];
    if (!invitation) throw new BridgeError("not_found", "invitation not found or expired");
    await deps.db
      .insert(workspaceMembers)
      .values({
        workspaceId: invitation.workspaceId,
        userId: c.get("userId"),
        role: invitation.role,
      })
      .onConflictDoUpdate({
        target: [workspaceMembers.workspaceId, workspaceMembers.userId],
        set: { role: invitation.role },
      });
    await deps.db
      .update(workspaceInvitations)
      .set({ acceptedAt: new Date() })
      .where(eq(workspaceInvitations.id, invitation.id));
    return c.json({ workspaceId: invitation.workspaceId });
  });

  return app;
}
