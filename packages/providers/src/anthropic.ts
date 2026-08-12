import Anthropic from "@anthropic-ai/sdk";
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

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { system, messages } = this.toAnthropicMessages(request.messages);

    const response = await this.client.messages.create({
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
    });

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
