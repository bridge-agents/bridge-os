/**
 * Provider adapter contract (ADR-0007). Everything vendor-specific lives
 * behind this interface; the runtime resolves a Manifest ModelRef
 * { provider, model } to a registered Provider at execution time.
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Present on assistant messages requesting tool execution. */
  toolCalls?: ToolCall[];
  /** Present on role:"tool" messages carrying a tool result. */
  toolCallId?: string;
}

/** Tool definition at the provider wire boundary (JSON Schema input). */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ProviderToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * `refusal` is a normal, successful outcome on current Anthropic models — the
 * safety classifiers declined and the content is empty or partial. Callers
 * must branch on the stop reason before reading message content.
 */
export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal";

export interface CompletionResult {
  message: ChatMessage;
  usage: TokenUsage;
  stopReason: StopReason;
  /** Provider-native model id that actually served the response. */
  model?: string;
}

export interface CompletionChunk {
  delta: string;
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
}

export interface Provider {
  /** Registered adapter id referenced by Manifest ModelRefs, e.g. "anthropic". */
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream?(request: CompletionRequest): AsyncIterable<CompletionChunk>;
  listModels?(): Promise<ModelInfo[]>;
}
