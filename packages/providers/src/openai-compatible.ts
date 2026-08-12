import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  Provider,
  StopReason,
  ToolCall,
} from "@bridge/sdk";

/**
 * One adapter for every endpoint speaking the OpenAI chat-completions wire
 * format: OpenAI itself, OpenRouter, self-hosted gateways, and local runtimes
 * like Ollama or LM Studio. They differ only by base URL and whether a key is
 * required, which is exactly what `provider_configs` already stores.
 *
 * Written against `fetch` rather than a vendor SDK: the surface used here is
 * small and stable, and it keeps the desktop bundle free of another
 * dependency tree (ADR-0011).
 */
export interface OpenAiCompatibleOptions {
  /** Adapter id this instance answers to, e.g. "openai" or "ollama". */
  id: string;
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

interface WireToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      // Local runtimes accept requests without a key; hosted ones need one.
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private body(request: CompletionRequest, stream: boolean) {
    return JSON.stringify({
      model: request.model,
      messages: request.messages.map((message) => toWireMessage(message)),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(stream ? { stream: true } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, false),
    });

    const body = (await res.json().catch(() => ({}))) as WireResponse;
    if (!res.ok) {
      throw new Error(`${this.id} request failed (${res.status}): ${body.error?.message ?? ""}`);
    }

    const choice = body.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      // Arguments arrive as a JSON string; malformed output must not kill the run.
      arguments: parseArguments(call.function?.arguments),
    }));

    return {
      message: {
        role: "assistant",
        content: choice?.message?.content ?? "",
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
      stopReason: stopReason(choice?.finish_reason),
      model: body.model,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, true),
    });
    if (!res.ok || !res.body) throw new Error(`${this.id} stream failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; keep the trailing partial line.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield { delta };
        } catch {
          // Ignore keep-alives and any frame that isn't a JSON payload.
        }
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    return (body.data ?? []).flatMap((model) => (model.id ? [{ id: model.id }] : []));
  }
}

function toWireMessage(message: ChatMessage) {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stopReason(finish: string | undefined): StopReason {
  switch (finish) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "end";
  }
}
