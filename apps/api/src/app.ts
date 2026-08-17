import { BridgeError } from "@bridge/core";
import { pingDb } from "@bridge/db";
import { SPEC_VERSION, safeParseManifest } from "@bridge/spec";
import { Hono } from "hono";
import { agentRoutes, templateRoutes } from "./agents.js";
import { approvalRoutes } from "./approvals.js";
import { architectRoutes } from "./architect.js";
import { attachmentRoutes } from "./attachments.js";
import { authRoutes } from "./auth.js";
import { automationRoutes } from "./automations.js";
import { channelWebhookRoutes } from "./channel-webhooks.js";
import { channelRoutes } from "./channels.js";
import { dashboardRoutes } from "./dashboards.js";
import { dataRoutes } from "./data.js";
import type { AppDeps, AppEnv } from "./http.js";
import { memoryRoutes } from "./memory.js";
import { providerRoutes } from "./providers.js";
import { runRoutes } from "./runs.js";
import { searchRoutes } from "./search.js";
import { secretRoutes } from "./secrets.js";
import { streamRoutes } from "./stream.js";
import { mountWebApp } from "./web.js";
import { workspaceRoutes } from "./workspaces.js";

export const API_VERSION = "0.5.0";

/**
 * Route layer only: validate, call domain modules, serialize (ADR-0005).
 * Every client — web, CLI, desktop, mobile, channels — uses exactly these
 * endpoints; none of them get a private path into the domain.
 */
export function buildApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  /**
   * Every route lives here and is mounted twice: at the root, which is what
   * the CLI and any HTTP client use, and under `/api`, which is the path the
   * web client asks for so one bundle works behind the Vite dev proxy and in
   * the packaged app where this process also serves the SPA (see web.ts).
   */
  const routes = new Hono<AppEnv>();

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

  routes.get("/health", async (c) => {
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

  routes.get("/v1/meta", (c) =>
    c.json({ name: "bridge", version: API_VERSION, specVersion: SPEC_VERSION }),
  );

  routes.post("/v1/manifests/validate", async (c) => {
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

  routes.route("/v1/auth", authRoutes(deps));
  routes.route("/v1/templates", templateRoutes());
  routes.route("/v1/workspaces", workspaceRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/agents", agentRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/automations", automationRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/providers", providerRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/channels", channelRoutes(deps));
  routes.route("/v1/channels", channelWebhookRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/secrets", secretRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/search", searchRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/memory", memoryRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/data", dataRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/dashboard", dashboardRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/architect", architectRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/approvals", approvalRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId/attachments", attachmentRoutes(deps));
  routes.route("/v1/workspaces/:workspaceId", streamRoutes(deps));
  // Run, conversation and lifecycle routes share one workspace-scoped mount.
  routes.route("/v1/workspaces/:workspaceId", runRoutes(deps));

  app.route("/", routes);
  app.route("/api", routes);

  // Only an installed Bridge sets this; in development Vite hosts the client.
  if (deps.webDir) mountWebApp(app, deps.webDir);

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
