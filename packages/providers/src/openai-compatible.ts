import type {
  ChatMessage,
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  DeltaHandler,
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

const MAX_RETRIES = 4;
/** Too many requests, and the transient server-side failures. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * How long to wait before trying again. The server's own `retry-after` wins,
 * whether it is given in seconds or as a date; otherwise exponential with a
 * little jitter, so a burst of parallel runs does not retry in lockstep.
 */
export function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), 60_000);
  }
  return Math.min(2 ** attempt * 500, 8_000) + Math.random() * 250;
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
      messages: request.messages.map((message) => toWireMessage(message, this.id)),
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
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.serviceTier === "fast" ? { service_tier: "fast" } : {}),
      // Servers that support it report usage on a final chunk; the rest ignore it.
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  /**
   * Every request goes through here, and is retried when the answer says
   * "not now".
   *
   * A rate limit is a delay, not a failure, but without this it became one:
   * the call threw, the run failed, and the executor retried the whole run
   * from the first token — paying again for everything already generated.
   * `retry-after` is obeyed when the server sends it, since it knows better
   * than any backoff curve we could invent.
   *
   * A refused connection is translated rather than retried: `fetch` throws a
   * bare `TypeError: fetch failed` with no status, no URL and no cause, which
   * reads as "something broke" when it almost always means a local model
   * server is not running or a base URL has a typo.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      } catch (cause) {
        lastError = cause;
        // A refused connection is not a rate limit: nothing is listening, and
        // waiting will not change that.
        break;
      }

      if (!RETRYABLE.has(response.status) || attempt === MAX_RETRIES) return response;
      const wait = retryDelay(response.headers.get("retry-after"), attempt);
      // Drain the body so the connection can be reused.
      await response.text().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    throw new Error(
      `Could not reach ${this.id} at ${this.baseUrl}. ` +
        (isLocal(this.baseUrl)
          ? "Is the local model server running?"
          : "Check the base URL and this machine's connection.") +
        ` (${lastError instanceof Error ? lastError.message : String(lastError)})`,
      { cause: lastError },
    );
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const res = await this.send("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, false),
    });

    const body = (await res.json().catch(() => ({}))) as WireResponse;
    if (!res.ok) {
      throw new Error(`${this.id} request failed (${res.status}): ${body.error?.message ?? ""}`);
    }

    return toResult(body);
  }

  /**
   * Streams text and reassembles the full response, tool calls included.
   *
   * The wire format sends tool calls as fragments keyed by index, with the
   * name in one chunk and the JSON arguments dribbled across later ones, so
   * they have to be accumulated rather than read from any single chunk.
   */
  async streamComplete(
    request: CompletionRequest,
    onDelta: DeltaHandler,
  ): Promise<CompletionResult> {
    const res = await this.send("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, true),
    });
    if (!res.ok || !res.body) {
      throw new Error(`${this.id} stream failed (${res.status})`);
    }

    // Plenty of self-hosted servers ignore `stream: true` and answer with a
    // normal JSON body. Parsing that as SSE would find no frames and silently
    // return an empty answer, so detect it and read it as a plain completion —
    // the caller just gets no deltas.
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      const body = (await res.json().catch(() => ({}))) as WireResponse;
      const result = toResult(body);
      if (result.message.content) onDelta(result.message.content);
      return result;
    }

    let content = "";
    let finish: string | undefined;
    let model: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const partials = new Map<number, { id?: string; name?: string; args: string }>();

    for await (const data of readSse(res.body)) {
      const chunk = JSON.parse(data) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: {
          delta?: { content?: string; tool_calls?: (WireToolCall & { index?: number })[] };
          finish_reason?: string;
        }[];
      };
      model ??= chunk.model;
      // Usage arrives on a final chunk when the server supports it.
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;

      const text = choice?.delta?.content;
      if (text) {
        content += text;
        onDelta(text);
      }

      for (const [position, call] of (choice?.delta?.tool_calls ?? []).entries()) {
        const index = call.index ?? position;
        const partial = partials.get(index) ?? { args: "" };
        if (call.id) partial.id = call.id;
        if (call.function?.name) partial.name = call.function.name;
        if (call.function?.arguments) partial.args += call.function.arguments;
        partials.set(index, partial);
      }
    }

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, partial]) => ({
        id: partial.id ?? `call_${index}`,
        name: partial.name ?? "",
        arguments: parseArguments(partial.args),
      }));

    return {
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
      },
      // Some servers omit finish_reason when tool calls stream; infer it.
      stopReason: stopReason(finish ?? (toolCalls.length ? "tool_calls" : undefined)),
      model,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const res = await this.send("/chat/completions", {
      method: "POST",
      headers: this.headers(),
      body: this.body(request, true),
    });
    if (!res.ok || !res.body) throw new Error(`${this.id} stream failed (${res.status})`);

    for await (const data of readSse(res.body)) {
      try {
        const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield { delta };
      } catch {
        // Ignore keep-alives and any frame that isn't a JSON payload.
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.send("/models", { headers: this.headers() });
    if (!res.ok) return [];
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    return (body.data ?? []).flatMap((model) => (model.id ? [{ id: model.id }] : []));
  }
}

/**
 * Yields the payload of each `data:` frame in an SSE body, stopping at
 * `[DONE]`. Frames can split across chunks, so the trailing partial line is
 * carried over rather than parsed.
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      if (data) yield data;
    }
  }
}

/** Maps a non-streamed chat-completions body into a Bridge result. */
function toResult(body: WireResponse): CompletionResult {
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

function toWireMessage(message: ChatMessage, providerId: string) {
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
  if (message.role === "user" && message.attachments?.length) {
    const content: Record<string, unknown>[] = [];
    if (message.content) content.push({ type: "text", text: message.content });

    for (const attachment of message.attachments) {
      const dataUrl = `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
      if (attachment.mimeType.startsWith("image/")) {
        content.push({ type: "image_url", image_url: { url: dataUrl } });
      } else if (attachment.mimeType === "application/pdf" && providerId === "openai") {
        content.push({
          type: "file",
          file: { filename: attachment.name, file_data: dataUrl },
        });
      } else if (isTextFile(attachment.mimeType, attachment.name)) {
        content.push({
          type: "text",
          text: `\n<attachment name="${attachment.name}">\n${decodeText(attachment.dataBase64)}\n</attachment>`,
        });
      } else {
        content.push({
          type: "text",
          text: `\n[Attached file: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)]`,
        });
      }
    }
    return { role: "user", content };
  }
  return { role: message.role, content: message.content };
}

/** Loopback and private hosts get advice about a local server, not the internet. */
function isLocal(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("10.")
    );
  } catch {
    return false;
  }
}

function isTextFile(mimeType: string, name: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript"].includes(mimeType) ||
    /\.(md|mdx|txt|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|sql|sh)$/i.test(
      name,
    )
  );
}

function decodeText(dataBase64: string): string {
  const bytes = Uint8Array.from(atob(dataBase64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
