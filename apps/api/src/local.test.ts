import { generateSecretKey, parseSecretKey } from "@bridge/core";
import { createDb, type DbHandle } from "@bridge/db";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ensureLocalAccount, LOCAL_EMAIL } from "./local.js";

let handle: DbHandle;
const silent = pino({ level: "silent" });

/** A local-mode app: no accounts, every request runs as the one owner. */
function localApp(localUserId: string) {
  return buildApp({
    db: handle.db,
    logger: silent,
    secretKey: parseSecretKey(generateSecretKey()),
    secureCookies: false,
    localUserId,
  });
}

/** The same app without local mode, i.e. how a server or Cloud runs. */
function serverApp() {
  return buildApp({
    db: handle.db,
    logger: silent,
    secretKey: parseSecretKey(generateSecretKey()),
    secureCookies: false,
  });
}

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();
});
afterEach(() => handle.close());

describe("ensureLocalAccount", () => {
  it("provisions one owner and workspace on first boot", async () => {
    const account = await ensureLocalAccount(handle.db);
    expect(account.userId).toMatch(/^usr_/);
    expect(account.workspaceId).toMatch(/^ws_/);
  });

  it("is idempotent — restarting does not pile up workspaces", async () => {
    const first = await ensureLocalAccount(handle.db);
    const second = await ensureLocalAccount(handle.db);
    expect(second).toEqual(first);

    const app = localApp(first.userId);
    const res = await app.request("/v1/workspaces");
    const body = (await res.json()) as { workspaces: unknown[] };
    expect(body.workspaces).toHaveLength(1);
  });

  it("leaves the account with no password, so it can never be logged into", async () => {
    await ensureLocalAccount(handle.db);
    const res = await serverApp().request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOCAL_EMAIL, password: "any-password-at-all" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("local mode", () => {
  it("answers without a token — there is nobody to sign in as", async () => {
    const account = await ensureLocalAccount(handle.db);
    const app = localApp(account.userId);

    const me = await app.request("/v1/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(LOCAL_EMAIL);

    const agents = await app.request(`/v1/workspaces/${account.workspaceId}/agents`);
    expect(agents.status).toBe(200);
  });

  it("ignores a stale token rather than locking you out of your own machine", async () => {
    const account = await ensureLocalAccount(handle.db);
    const res = await localApp(account.userId).request("/v1/auth/me", {
      headers: { authorization: "Bearer a-token-from-some-previous-server" },
    });
    expect(res.status).toBe(200);
  });

  it("still scopes to the local workspace, not to everything", async () => {
    const account = await ensureLocalAccount(handle.db);
    const app = localApp(account.userId);

    // A workspace the local owner is not a member of stays invisible.
    const other = await serverApp().request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com", password: "a-sufficiently-long-pass" }),
    });
    const foreign = (await other.json()) as { workspace: { id: string } };

    const res = await app.request(`/v1/workspaces/${foreign.workspace.id}/agents`);
    expect(res.status).toBe(404);
  });
});

describe("server mode", () => {
  it("still requires authentication — local mode must not leak into servers", async () => {
    await ensureLocalAccount(handle.db);
    const app = serverApp();

    expect((await app.request("/v1/auth/me")).status).toBe(401);
    expect((await app.request("/v1/workspaces")).status).toBe(401);
    expect(
      (await app.request("/v1/auth/me", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
  });
});
