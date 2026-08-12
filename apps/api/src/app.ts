import { BridgeError, type Logger } from "@bridge/core";
import { type Db, pingDb } from "@bridge/db";
import { SPEC_VERSION, safeParseManifest } from "@bridge/spec";
import { Hono } from "hono";

export interface AppDeps {
  logger: Logger;
  /** Absent when the API runs without a database (degraded, health reports it). */
  db?: Db;
}

export const API_VERSION = "0.1.0";

/**
 * Route layer only: validate, call domain modules, serialize (ADR-0005).
 * Domain logic lands in Phase 2+ modules, never in routes.
 */
export function buildApp({ logger, db }: AppDeps) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header("x-request-id", requestId);
    const start = performance.now();
    await next();
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
      },
      "request",
    );
  });

  app.get("/health", async (c) => {
    let dbStatus: "up" | "down" | "unconfigured" = "unconfigured";
    if (db) {
      try {
        await pingDb(db);
        dbStatus = "up";
      } catch {
        dbStatus = "down";
      }
    }
    const healthy = dbStatus !== "down";
    return c.json(
      { status: healthy ? "ok" : "degraded", version: API_VERSION, checks: { db: dbStatus } },
      healthy ? 200 : 503,
    );
  });

  app.get("/v1/meta", (c) =>
    c.json({ name: "bridge", version: API_VERSION, specVersion: SPEC_VERSION }),
  );

  app.post("/v1/manifests/validate", async (c) => {
    const body = await c.req.json().catch(() => {
      throw new BridgeError("validation_failed", "request body must be JSON");
    });
    const result = safeParseManifest(body);
    if (!result.success) {
      return c.json(
        {
          valid: false,
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        422,
      );
    }
    // Returns the normalized manifest (defaults applied) — clients persist this form.
    return c.json({ valid: true, manifest: result.data });
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: `no route for ${c.req.path}` } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof BridgeError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.httpStatus as 400,
      );
    }
    logger.error({ err }, "unhandled error");
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  return app;
}
