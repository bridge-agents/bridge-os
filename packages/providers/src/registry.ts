import type { Provider } from "@bridge/sdk";
import { AnthropicProvider } from "./anthropic.js";
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

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("anthropic requires an API key");
    return new AnthropicProvider({ apiKey, baseUrl });
  }

  const resolvedBaseUrl = baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!resolvedBaseUrl) throw new UnsupportedProviderError(provider);

  const needsKey = provider === "openai" || provider === "openrouter";
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
  "openai-compatible",
  "ollama",
] as const;
