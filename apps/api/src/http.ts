import { BridgeError, type Logger } from "@bridge/core";
import type { Db } from "@bridge/db";
import type { Context } from "hono";
import type { z } from "zod";

export interface AppDeps {
  db: Db;
  logger: Logger;
  /** 32-byte key for secret encryption (BRIDGE_SECRET_KEY). */
  secretKey: Buffer;
  /** Marks session cookies Secure; disable only for local http development. */
  secureCookies?: boolean;
  /**
   * Local desktop mode: the owner every unauthenticated request runs as.
   * Set only when Bridge owns the machine it runs on (see local.ts); unset
   * for server and Cloud deployments, where auth works normally.
   */
  localUserId?: string;
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface AppEnv {
  Variables: {
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
  };
}

/** Validate a JSON body against a schema, or fail with the standard issue shape. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => {
    throw new BridgeError("validation_failed", "request body must be JSON");
  });
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BridgeError(
      "validation_failed",
      "invalid request body",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Fixed-window limiter for credential endpoints.
 *
 * ponytail: in-process counters, so it protects a single API instance. Move
 * to a shared store when Bridge Cloud runs more than one (the desktop and
 * self-hosted single-node cases are the ones that matter today).
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return function check(key: string): void {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      }
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      throw new BridgeError("rate_limited", "too many attempts, try again shortly");
    }
  };
}
