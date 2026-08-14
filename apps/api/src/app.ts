import { BridgeError } from "@bridge/core";
import { pingDb } from "@bridge/db";
import { SPEC_VERSION, safeParseManifest } from "@bridge/spec";
import { Hono } from "hono";
import { agentRoutes, templateRoutes } from "./agents.js";
import { approvalRoutes } from "./approvals.js";
import { architectRoutes } from "./architect.js";
import { authRoutes } from "./auth.js";
import { dataRoutes } from "./data.js";
import type { AppDeps, AppEnv } from "./http.js";
import { providerRoutes } from "./providers.js";
import { runRoutes } from "./runs.js";
import { secretRoutes } from "./secrets.js";
import { streamRoutes } from "./stream.js";
import { workspaceRoutes } from "./workspaces.js";

export const API_VERSION = "0.5.0";

/**
 * Route layer only: validate, call domain modules, serialize (ADR-0005).
 * Every client — web, CLI, desktop, mobile, channels — uses exactly these
 * endpoints; none of them get a private path into the domain.
 */
export function buildApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header("x-request-id", requestId);
    const start = performance.now();
    await next();
    deps.logger.info(
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
    let db: "up" | "down" = "up";
    try {
      await pingDb(deps.db);
    } catch {
      db = "down";
    }
    return c.json(
      { status: db === "up" ? "ok" : "degraded", version: API_VERSION, checks: { db } },
      db === "up" ? 200 : 503,
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

  app.route("/v1/auth", authRoutes(deps));
  app.route("/v1/templates", templateRoutes());
  app.route("/v1/workspaces", workspaceRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/agents", agentRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/providers", providerRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/secrets", secretRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/data", dataRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/architect", architectRoutes(deps));
  app.route("/v1/workspaces/:workspaceId/approvals", approvalRoutes(deps));
  app.route("/v1/workspaces/:workspaceId", streamRoutes(deps));
  // Run, conversation and lifecycle routes share one workspace-scoped mount.
  app.route("/v1/workspaces/:workspaceId", runRoutes(deps));

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
    deps.logger.error({ err }, "unhandled error");
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  return app;
}
