import { createLogger, generateSecretKey, parseSecretKey } from "@bridge/core";
import { createDb, type DbHandle } from "@bridge/db";
import pino from "pino";
import { buildApp } from "./app.js";

export interface TestApp {
  app: ReturnType<typeof buildApp>;
  handle: DbHandle;
  /** Everything the logger emitted, for asserting secrets never reach it. */
  logs: string[];
  close(): Promise<void>;
}

/**
 * A complete Bridge API backed by embedded Postgres. Real schema, real
 * migrations, real queries — no Docker and no shared state between tests.
 */
export async function createTestApp(): Promise<TestApp> {
  const handle = await createDb("pglite:memory");
  await handle.migrate();

  const logs: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void logs.push(line) });

  return {
    app: buildApp({
      db: handle.db,
      logger,
      secretKey: parseSecretKey(generateSecretKey()),
      secureCookies: false,
    }),
    handle,
    logs,
    close: () => handle.close(),
  };
}

export interface TestUser {
  token: string;
  userId: string;
  workspaceId: string;
  email: string;
}

/** Sign up a user and return their session token and default workspace. */
export async function signUp(app: TestApp["app"], email: string): Promise<TestUser> {
  const res = await app.request("/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "a-sufficiently-long-password" }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    token: string;
    user: { id: string };
    workspace: { id: string };
  };
  return { token: body.token, userId: body.user.id, workspaceId: body.workspace.id, email };
}

/** Authenticated request helper using the bearer path (the CLI's path). */
export function as(app: TestApp["app"], user: Pick<TestUser, "token">) {
  return (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${user.token}`,
        ...(init.headers ?? {}),
      },
    });
}

export { createLogger };
