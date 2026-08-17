import { spawn } from "node:child_process";
import { BridgeError, id } from "@bridge/core";
import { providerConfigs, secrets } from "@bridge/db";
import { type CliProviderId, cliAuthStatus } from "@bridge/providers";
import { EncryptedDbSecretStore, providerResolver } from "@bridge/runtime";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * Providers a workspace can connect. Adding one here does not implement it —
 * the adapter does (Phase 3) — but the credential path is identical for all
 * of them, including local endpoints that need no key at all.
 */
const KNOWN_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "google-gemini",
  "github-models",
  "deepseek",
  "moonshot",
  "minimax",
  "mistral",
  "qwen-cloud",
  "groq",
  "xai",
  "together-ai",
  "fireworks-ai",
  "cerebras",
  "openai-compatible",
  "ollama",
  "codex",
  "claude-code",
  "github-copilot",
] as const;

const CLI_PROVIDERS = new Set<string>(["codex", "claude-code", "github-copilot"]);

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

  app.get("/cli-status", async (c) => {
    const [codex, claudeCode, githubCopilot] = await Promise.all([
      cliAuthStatus("codex"),
      cliAuthStatus("claude-code"),
      cliAuthStatus("github-copilot"),
    ]);
    return c.json({
      providers: { codex, "claude-code": claudeCode, "github-copilot": githubCopilot },
    });
  });

  /**
   * Can each connected provider actually be reached?
   *
   * "Connected" only ever meant a row exists — which is why a schedule can
   * fail at 3am against a local model server that has not been running for a
   * week. This asks each one, so the answer is available before the run
   * rather than in its error message.
   */
  app.get("/health", async (c) => {
    const workspaceId = c.get("workspaceId");
    const configured = await deps.db
      .select({ provider: providerConfigs.provider, baseUrl: providerConfigs.baseUrl })
      .from(providerConfigs)
      .where(eq(providerConfigs.workspaceId, workspaceId));
    const resolveProvider = providerResolver(deps.db, deps.secretKey);

    const providers = await Promise.all(
      configured.map(async ({ provider, baseUrl }) => {
        try {
          const adapter = await resolveProvider(workspaceId, provider);
          // Listing models is the cheapest call that proves the whole path:
          // credentials resolve, the endpoint answers, and it speaks the
          // protocol we expect.
          await adapter.listModels?.();
          return { provider, baseUrl, ok: true as const };
        } catch (error) {
          return {
            provider,
            baseUrl,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return c.json({ providers });
  });

  app.get("/models", async (c) => {
    const workspaceId = c.get("workspaceId");
    const configured = await deps.db
      .select({ provider: providerConfigs.provider })
      .from(providerConfigs)
      .where(eq(providerConfigs.workspaceId, workspaceId));
    const resolveProvider = providerResolver(deps.db, deps.secretKey);

    const catalogs = await Promise.all(
      configured.map(async ({ provider }) => {
        try {
          const adapter = await resolveProvider(workspaceId, provider);
          const discovered = (await adapter.listModels?.()) ?? [];
          const models = discovered.length ? discovered : fallbackModels(provider);
          return models.map((model) => enrichModel(provider, model));
        } catch (error) {
          deps.logger.warn({ provider, err: error }, "provider model discovery failed");
          return fallbackModels(provider).map((model) => enrichModel(provider, model));
        }
      }),
    );
    return c.json({ models: catalogs.flat() });
  });

  app.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: providerConfigs.id,
        provider: providerConfigs.provider,
        authType: providerConfigs.authType,
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
    if (CLI_PROVIDERS.has(body.provider)) {
      throw new BridgeError(
        "validation_failed",
        `${body.provider} connects through its OAuth sign-in, not an API key`,
      );
    }
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
        authType: needsKey ? "api-key" : "endpoint",
        secretId: secretRef?.id,
        baseUrl: body.baseUrl,
      })
      .onConflictDoUpdate({
        target: [providerConfigs.workspaceId, providerConfigs.provider],
        set: {
          secretId: secretRef?.id,
          baseUrl: body.baseUrl,
          authType: needsKey ? "api-key" : "endpoint",
        },
      })
      .returning({ id: providerConfigs.id, provider: providerConfigs.provider });

    return c.json({ provider: { ...saved, keyHint: secretRef?.hint ?? null } }, 201);
  });

  app.post("/:provider/oauth/start", requireRole("owner", "admin"), async (c) => {
    const provider = parseCliProvider(c.req.param("provider"));
    const status = await cliAuthStatus(provider);
    if (!status.installed) {
      throw new BridgeError("validation_failed", `${providerLabel(provider)} CLI is not installed`);
    }
    if (status.loggedIn) {
      const saved = await saveCliProvider(deps, c.get("workspaceId"), provider);
      return c.json({ connected: true, launched: false, provider: saved, status });
    }

    const command =
      provider === "codex"
        ? "codex login --device-auth"
        : provider === "claude-code"
          ? "claude auth login"
          : "copilot login";
    const launched = launchAuthTerminal(command);
    return c.json({ connected: false, launched, command, status }, 202);
  });

  app.post("/:provider/oauth/connect", requireRole("owner", "admin"), async (c) => {
    const provider = parseCliProvider(c.req.param("provider"));
    const status = await cliAuthStatus(provider);
    if (!status.loggedIn) {
      throw new BridgeError("conflict", `${providerLabel(provider)} sign-in has not completed`);
    }
    const saved = await saveCliProvider(deps, c.get("workspaceId"), provider);
    return c.json({ provider: saved, status }, 201);
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

async function saveCliProvider(deps: AppDeps, workspaceId: string, provider: CliProviderId) {
  const [saved] = await deps.db
    .insert(providerConfigs)
    .values({ id: id("prv"), workspaceId, provider, authType: "oauth-cli" })
    .onConflictDoUpdate({
      target: [providerConfigs.workspaceId, providerConfigs.provider],
      set: { authType: "oauth-cli", secretId: null, baseUrl: null },
    })
    .returning({
      id: providerConfigs.id,
      provider: providerConfigs.provider,
      authType: providerConfigs.authType,
      baseUrl: providerConfigs.baseUrl,
    });
  return { ...saved, keyHint: null };
}

function parseCliProvider(value: string): CliProviderId {
  if (value === "codex" || value === "claude-code" || value === "github-copilot") return value;
  throw new BridgeError("not_found", "OAuth provider not found");
}

function providerLabel(provider: CliProviderId): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  return "GitHub Copilot";
}

function launchAuthTerminal(command: string): boolean {
  if (process.platform !== "darwin") return false;
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const child = spawn("osascript", [
    "-e",
    `tell application "Terminal" to activate`,
    "-e",
    `tell application "Terminal" to do script "${escaped}"`,
  ]);
  child.unref();
  return true;
}

export function enrichModel(
  provider: string,
  model: {
    id: string;
    displayName?: string;
    reasoningEfforts?: unknown[];
    serviceTiers?: unknown[];
    inputModalities?: unknown[];
  },
) {
  const inferredReasoning = /(^|[-_/])(gpt-5|o[1-9]|claude|gemini-2\.5|gemini-3)/i.test(model.id);
  const advertisedReasoning = model.reasoningEfforts?.length
    ? model.reasoningEfforts
    : inferredReasoning
      ? provider === "anthropic"
        ? ["low", "medium", "high", "max"]
        : ["low", "medium", "high"]
      : [];
  // A non-empty effort list means the adapter can explicitly control reasoning.
  // `none` disables that control and is already understood by every Bridge adapter.
  const reasoningEfforts = advertisedReasoning.length
    ? ["none", ...advertisedReasoning.filter((effort) => effort !== "none")]
    : [];
  const serviceTiers = model.serviceTiers?.length
    ? model.serviceTiers
    : /^gpt-5\.6-(sol|terra|luna)$/i.test(model.id)
      ? ["default", "fast"]
      : ["default"];
  return {
    provider,
    providerName: providerDisplayName(provider),
    id: model.id,
    displayName: model.displayName ?? model.id,
    reasoningEfforts,
    serviceTiers,
    inputModalities: model.inputModalities?.length
      ? model.inputModalities
      : ["text", "image", "file"],
  };
}

function fallbackModels(provider: string) {
  const models: Record<string, string[]> = {
    openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    anthropic: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
    "google-gemini": ["gemini-3.5-flash", "gemini-3.1-pro-preview"],
    "github-models": ["openai/gpt-4.1", "deepseek/DeepSeek-R1"],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    minimax: ["MiniMax-M2.7", "MiniMax-M2.5"],
    mistral: ["mistral-large-latest", "codestral-latest"],
    "qwen-cloud": ["qwen3.7-plus", "qwen3.7-max"],
    groq: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
    xai: ["grok-4", "grok-4-fast"],
    "together-ai": ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    "fireworks-ai": ["accounts/fireworks/models/llama-v3p3-70b-instruct"],
    cerebras: ["gpt-oss-120b", "llama3.1-8b"],
  };
  return (models[provider] ?? []).map((id) => ({ id }));
}

function providerDisplayName(provider: string): string {
  return (
    {
      openai: "OpenAI",
      anthropic: "Anthropic",
      openrouter: "OpenRouter",
      ollama: "Ollama",
      "openai-compatible": "OpenAI compatible",
      codex: "Codex (ChatGPT plan)",
      "claude-code": "Claude Code (Claude plan)",
      "github-copilot": "GitHub Copilot (Copilot plan)",
      "google-gemini": "Google Gemini",
      "github-models": "GitHub Models",
      deepseek: "DeepSeek",
      moonshot: "Moonshot AI",
      minimax: "MiniMax",
      mistral: "Mistral AI",
      "qwen-cloud": "Qwen Cloud",
      groq: "Groq",
      xai: "xAI",
      "together-ai": "Together AI",
      "fireworks-ai": "Fireworks AI",
      cerebras: "Cerebras",
    }[provider] ?? provider
  );
}
