import { BridgeError } from "@bridge/core";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * Named workspace secrets — bot tokens, webhook signing keys, anything a
 * manifest refers to by name instead of embedding.
 *
 * Values go in and never come back out: the API returns masked hints, and only
 * the runtime resolves plaintext, for one adapter call (ADR-0011). Provider
 * credentials keep their own endpoint and reserve the "provider:" prefix.
 */
const PutSecretSchema = z.object({
  /** Manifests reference this, so keep it to a stable, typeable shape. */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "use lowercase letters, digits, dashes and underscores"),
  value: z.string().min(1).max(8192),
});

export function secretRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = new EncryptedDbSecretStore(deps.db, deps.secretKey);
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const all = await store.list(c.get("workspaceId"));
    // Provider keys are managed at /providers; showing them twice invites
    // deleting one from under the other.
    return c.json({ secrets: all.filter((secret) => !secret.name.startsWith("provider:")) });
  });

  app.put("/", requireRole("owner", "admin"), async (c) => {
    // The name pattern has no colon, so "provider:…" is unreachable here and
    // workspace secrets cannot collide with a stored provider credential.
    const body = await parseBody(c, PutSecretSchema);
    return c.json({ secret: await store.put(c.get("workspaceId"), body.name, body.value) }, 201);
  });

  app.delete("/:secretId", requireRole("owner", "admin"), async (c) => {
    const deleted = await store.delete(c.get("workspaceId"), c.req.param("secretId"));
    if (!deleted) throw new BridgeError("not_found", "secret not found");
    return c.body(null, 204);
  });

  return app;
}
