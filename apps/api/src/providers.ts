import { BridgeError, id } from "@bridge/core";
import { providerConfigs, secrets } from "@bridge/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";
import { EncryptedDbSecretStore } from "./secrets.js";

/**
 * Providers a workspace can connect. Adding one here does not implement it —
 * the adapter does (Phase 3) — but the credential path is identical for all
 * of them, including local endpoints that need no key at all.
 */
const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "openai-compatible",
  "ollama",
] as const;

const ConnectProviderSchema = z.object({
  provider: z.enum(KNOWN_PROVIDERS),
  apiKey: z.string().min(1).max(4096).optional(),
  /** Required for self-hosted and local inference endpoints. */
  baseUrl: z.url().optional(),
});

export function providerRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = new EncryptedDbSecretStore(deps.db, deps.secretKey);
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/available", (c) => c.json({ providers: KNOWN_PROVIDERS }));

  app.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: providerConfigs.id,
        provider: providerConfigs.provider,
        baseUrl: providerConfigs.baseUrl,
        createdAt: providerConfigs.createdAt,
        // The masked hint is the only part of a credential that ever leaves the server.
        keyHint: secrets.hint,
      })
      .from(providerConfigs)
      .leftJoin(secrets, eq(secrets.id, providerConfigs.secretId))
      .where(eq(providerConfigs.workspaceId, c.get("workspaceId")));
    return c.json({ providers: rows });
  });

  app.put("/", requireRole("owner", "admin"), async (c) => {
    const body = await parseBody(c, ConnectProviderSchema);
    const workspaceId = c.get("workspaceId");

    // Local inference needs a URL, not a key; hosted APIs need the key.
    const needsKey = body.provider !== "ollama" && body.provider !== "openai-compatible";
    if (needsKey && !body.apiKey) {
      throw new BridgeError("validation_failed", `${body.provider} requires an API key`);
    }
    if (!needsKey && !body.baseUrl) {
      throw new BridgeError("validation_failed", `${body.provider} requires a base URL`);
    }

    const secretRef = body.apiKey
      ? await store.put(workspaceId, `provider:${body.provider}`, body.apiKey)
      : undefined;

    const [saved] = await deps.db
      .insert(providerConfigs)
      .values({
        id: id("prv"),
        workspaceId,
        provider: body.provider,
        secretId: secretRef?.id,
        baseUrl: body.baseUrl,
      })
      .onConflictDoUpdate({
        target: [providerConfigs.workspaceId, providerConfigs.provider],
        set: { secretId: secretRef?.id, baseUrl: body.baseUrl },
      })
      .returning({ id: providerConfigs.id, provider: providerConfigs.provider });

    return c.json({ provider: { ...saved, keyHint: secretRef?.hint ?? null } }, 201);
  });

  app.delete("/:provider", requireRole("owner", "admin"), async (c) => {
    const workspaceId = c.get("workspaceId");
    const deleted = await deps.db
      .delete(providerConfigs)
      .where(
        and(
          eq(providerConfigs.workspaceId, workspaceId),
          eq(providerConfigs.provider, c.req.param("provider")),
        ),
      )
      .returning({ secretId: providerConfigs.secretId });
    if (deleted.length === 0) throw new BridgeError("not_found", "provider not connected");

    // Disconnecting must also destroy the credential, not orphan it.
    const secretId = deleted[0]?.secretId;
    if (secretId) await store.delete(workspaceId, secretId);
    return c.body(null, 204);
  });

  return app;
}
