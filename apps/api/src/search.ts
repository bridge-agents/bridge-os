import { BridgeError } from "@bridge/core";
import { searchConfigs } from "@bridge/db";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export function searchRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = new EncryptedDbSecretStore(deps.db, deps.secretKey);
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const [config] = await deps.db
      .select()
      .from(searchConfigs)
      .where(eq(searchConfigs.workspaceId, c.get("workspaceId")));
    if (!config) return c.json({ search: null });
    const secret = config.secretId
      ? (await store.list(c.get("workspaceId"))).find((entry) => entry.id === config.secretId)
      : undefined;
    return c.json({
      search: {
        provider: config.provider,
        endpoint: config.endpoint,
        apiKeyHint: secret?.hint ?? null,
      },
    });
  });

  app.put("/", requireRole("owner", "admin"), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        provider: z.enum(["brave", "custom"]),
        endpoint: z.url().optional(),
        apiKey: z.string().min(1).max(8192).optional(),
      }),
    );
    const endpoint = body.provider === "brave" ? BRAVE_ENDPOINT : body.endpoint;
    if (!endpoint) throw new BridgeError("validation_failed", "custom search needs an endpoint");
    const existing = await deps.db
      .select()
      .from(searchConfigs)
      .where(eq(searchConfigs.workspaceId, c.get("workspaceId")));
    let secretId = existing[0]?.secretId ?? null;
    if (body.provider === "brave" && !body.apiKey && !secretId) {
      throw new BridgeError("validation_failed", "Brave Search needs an API key");
    }
    if (body.apiKey) {
      secretId = (await store.put(c.get("workspaceId"), "web-search-api-key", body.apiKey)).id;
    }
    await deps.db
      .insert(searchConfigs)
      .values({
        workspaceId: c.get("workspaceId"),
        provider: body.provider,
        endpoint,
        secretId,
      })
      .onConflictDoUpdate({
        target: searchConfigs.workspaceId,
        set: { provider: body.provider, endpoint, secretId, updatedAt: new Date() },
      });
    return c.json({ search: { provider: body.provider, endpoint } });
  });

  app.delete("/", requireRole("owner", "admin"), async (c) => {
    const [config] = await deps.db
      .delete(searchConfigs)
      .where(eq(searchConfigs.workspaceId, c.get("workspaceId")))
      .returning({ secretId: searchConfigs.secretId });
    if (!config) throw new BridgeError("not_found", "web search is not configured");
    if (config.secretId) await store.delete(c.get("workspaceId"), config.secretId);
    return c.body(null, 204);
  });

  return app;
}
