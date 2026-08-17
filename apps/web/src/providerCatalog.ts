export interface ProviderCatalogEntry {
  id: string;
  name: string;
  description: string;
  defaultBaseUrl?: string;
  needsBaseUrl?: boolean;
  supportsBaseUrl?: boolean;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "anthropic", name: "Anthropic", description: "Claude models through the Anthropic API." },
  { id: "openai", name: "OpenAI", description: "GPT and reasoning models through the OpenAI API." },
  {
    id: "google-gemini",
    name: "Google Gemini",
    description: "Gemini models through Google's OpenAI-compatible API.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "A unified catalog spanning many model vendors.",
  },
  {
    id: "github-models",
    name: "GitHub Models",
    description: "GitHub-hosted inference using a token with Models permission.",
  },
  { id: "deepseek", name: "DeepSeek", description: "DeepSeek chat and reasoning models." },
  { id: "moonshot", name: "Moonshot AI", description: "Kimi and Moonshot hosted models." },
  { id: "minimax", name: "MiniMax", description: "MiniMax text and coding models." },
  { id: "mistral", name: "Mistral AI", description: "Mistral and Codestral hosted models." },
  {
    id: "qwen-cloud",
    name: "Qwen Cloud",
    description: "Qwen models through Alibaba Model Studio or a Qwen Cloud endpoint.",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    supportsBaseUrl: true,
  },
  { id: "groq", name: "Groq", description: "Low-latency OpenAI-compatible inference." },
  { id: "xai", name: "xAI", description: "Grok models through the xAI API." },
  { id: "together-ai", name: "Together AI", description: "Hosted open and specialist models." },
  { id: "fireworks-ai", name: "Fireworks AI", description: "Fast serverless model inference." },
  { id: "cerebras", name: "Cerebras", description: "High-speed Cerebras inference." },
  {
    id: "ollama",
    name: "Ollama",
    description: "Models running locally through Ollama.",
    defaultBaseUrl: "http://localhost:11434/v1",
    needsBaseUrl: true,
  },
  {
    id: "openai-compatible",
    name: "OpenAI compatible",
    description: "LM Studio, vLLM, proxies, and custom compatible endpoints.",
    needsBaseUrl: true,
  },
];

export function providerCatalogEntry(provider: string): ProviderCatalogEntry {
  return (
    PROVIDER_CATALOG.find((entry) => entry.id === provider) ?? {
      id: provider,
      name: provider,
      description: "Model provider",
    }
  );
}

export function providerName(provider: string): string {
  return (
    {
      codex: "Codex",
      "claude-code": "Claude Code",
      "github-copilot": "GitHub Copilot",
    }[provider] ?? providerCatalogEntry(provider).name
  );
}
