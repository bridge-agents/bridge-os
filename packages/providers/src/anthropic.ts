import Anthropic from "@anthropic-ai/sdk";
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
 * Anthropic adapter built on the official SDK.
 *
 * Two API rules this deliberately encodes:
 *  - Sampling parameters (temperature/top_p/top_k) are rejected by current
 *    models, so `request.temperature` is intentionally not forwarded. Steer
 *    behaviour through instructions instead.
 *  - `stop_reason: "refusal"` is a successful HTTP 200 with empty or partial
 *    content, not an error. It is mapped through so the runtime can end the
 *    run cleanly rather than reading content that isn't there.
 */
export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; baseUrl?: string }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      /**
       * Let the SDK ride out a rate limit rather than failing the run.
       *
       * It already reads `retry-after` and backs off; without a number here
       * it gives up after two tries, and a 429 then costs the whole run —
       * which is retried from the top, re-spending every token it had
       * already paid for.
       */
      maxRetries: 5,
    });
  }

  /**
   * Bridge keeps system turns in the message list; Anthropic takes them as a
   * separate parameter, and tool results ride on user turns.
   */
  private toAnthropicMessages(messages: ChatMessage[]) {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const converted: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;

      if (message.role === "tool") {
        converted.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId ?? "",
              content: message.content,
            },
          ],
        });
        continue;
      }

      if (message.role === "assistant" && message.toolCalls?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const call of message.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments,
          });
        }
        converted.push({ role: "assistant", content: blocks });
        continue;
      }

      if (message.role === "user" && message.attachments?.length) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (message.content) blocks.push({ type: "text", text: message.content });
        for (const attachment of message.attachments) {
          if (attachment.mimeType.startsWith("image/")) {
            blocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: attachment.mimeType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: attachment.dataBase64,
              },
            });
          } else if (attachment.mimeType === "application/pdf") {
            blocks.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: attachment.dataBase64,
              },
              title: attachment.name,
            } as Anthropic.ContentBlockParam);
          } else if (isTextFile(attachment.mimeType, attachment.name)) {
            blocks.push({
              type: "text",
              text: `\n<attachment name="${attachment.name}">\n${decodeText(attachment.dataBase64)}\n</attachment>`,
            });
          } else {
            blocks.push({
              type: "text",
              text: `\n[Attached file: ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)]`,
            });
          }
        }
        converted.push({ role: "user", content: blocks });
        continue;
      }

      // Anthropic rejects empty content blocks; skip rather than fail the run.
      if (!message.content) continue;
      converted.push({ role: message.role, content: message.content });
    }

    return { system, messages: converted };
  }

  private static stopReason(reason: string | null): StopReason {
    switch (reason) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      case "refusal":
        return "refusal";
      default:
        return "end";
    }
  }

  /** One place that turns an Anthropic message into a Bridge result. */
  private static toResult(response: Anthropic.Message): CompletionResult {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      message: {
        role: "assistant",
        content: text,
        ...(toolCalls.length ? { toolCalls } : {}),
      },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: AnthropicProvider.stopReason(response.stop_reason),
      model: response.model,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { system, messages } = this.toAnthropicMessages(request.messages);

    const response = await reachable(async () =>
      this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 16000,
        ...(system ? { system } : {}),
        messages,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
        ...(request.reasoningEffort && request.reasoningEffort !== "none"
          ? { output_config: { effort: request.reasoningEffort } }
          : {}),
      } as Anthropic.MessageCreateParamsNonStreaming),
    );

    return AnthropicProvider.toResult(response);
  }

  /**
   * Streams text while it is generated and still returns the complete
   * message. The SDK assembles the final message for us, so tool calls
   * survive streaming untouched.
   */
  async streamComplete(
    request: CompletionRequest,
    onDelta: DeltaHandler,
  ): Promise<CompletionResult> {
    const { system, messages } = this.toAnthropicMessages(request.messages);

    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens ?? 16000,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      ...(request.reasoningEffort && request.reasoningEffort !== "none"
        ? { output_config: { effort: request.reasoningEffort } }
        : {}),
    } as Anthropic.MessageStreamParams);

    stream.on("text", (delta) => onDelta(delta));
    return AnthropicProvider.toResult(await stream.finalMessage());
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    const { system, messages } = this.toAnthropicMessages(request.messages);

    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens ?? 64000,
      ...(system ? { system } : {}),
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { delta: event.delta.text };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.client.models.list();
    return models.data.map((model) => ({ id: model.id }));
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

/**
 * Turn a connection failure into something a person can act on.
 *
 * The SDK surfaces an unreachable host as a bare `fetch failed` with no URL
 * and no cause — which reads as "something broke" rather than "you are
 * offline" or "the endpoint is wrong". Only connection errors are rewritten;
 * an API error already says what it means.
 */
async function reachable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(message)) throw cause;
    throw new Error(
      `Could not reach Anthropic. Check this machine's connection and the API key. (${message})`,
      { cause },
    );
  }
}
