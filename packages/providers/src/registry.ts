import type { Provider } from "@bridge/sdk";
import { AnthropicProvider } from "./anthropic.js";
import { CliSubscriptionProvider } from "./cli-subscription.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

export interface ProviderCredentials {
  /** Adapter id, matching `provider_configs.provider` and Manifest ModelRefs. */
  provider: string;
  /** Resolved at execution time from the SecretStore; absent for local endpoints. */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Default endpoints for providers that have one; the rest must supply a base URL. */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "google-gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  "github-models": "https://models.github.ai/inference",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.ai/v1",
  minimax: "https://api.minimax.io/v1",
  mistral: "https://api.mistral.ai/v1",
  "qwen-cloud": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  "together-ai": "https://api.together.xyz/v1",
  "fireworks-ai": "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  ollama: "http://localhost:11434/v1",
};

export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`no adapter registered for provider "${provider}"`);
  }
}

/**
 * Resolve a configured provider into a runnable adapter. Everything
 * vendor-specific stops here — the runtime only ever sees `Provider`.
 */
export function createProvider(credentials: ProviderCredentials): Provider {
  const { provider, apiKey, baseUrl, fetchImpl } = credentials;

  if (provider === "codex" || provider === "claude-code" || provider === "github-copilot") {
    return new CliSubscriptionProvider(provider);
  }

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("anthropic requires an API key");
    return new AnthropicProvider({ apiKey, baseUrl });
  }

  const resolvedBaseUrl = baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!resolvedBaseUrl) throw new UnsupportedProviderError(provider);

  const needsKey = provider !== "ollama" && provider !== "openai-compatible";
  if (needsKey && !apiKey) throw new Error(`${provider} requires an API key`);

  return new OpenAiCompatibleProvider({
    id: provider,
    baseUrl: resolvedBaseUrl,
    apiKey,
    fetchImpl,
  });
}

/** Providers this build can actually execute, for API and UI listings. */
export const SUPPORTED_PROVIDERS = [
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
