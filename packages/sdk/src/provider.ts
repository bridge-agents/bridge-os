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

/** A file attached to a user turn, loaded only for the provider call. */
export interface ModelAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Present on user messages that include uploaded files. */
  attachments?: ModelAttachment[];
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
  /** Provider-supported reasoning depth selected for this run. */
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Faster, higher-cost serving tier where the selected model exposes it. */
  serviceTier?: "default" | "fast";
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
  displayName?: string;
  contextWindow?: number;
  reasoningEfforts?: CompletionRequest["reasoningEffort"][];
  serviceTiers?: CompletionRequest["serviceTier"][];
  inputModalities?: ("text" | "image" | "file")[];
}

export type DeltaHandler = (text: string) => void;

export interface Provider {
  /** Registered adapter id referenced by Manifest ModelRefs, e.g. "anthropic". */
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Stream text as it arrives *and* resolve to the same result `complete()`
   * would return, tool calls included.
   *
   * This is what the agent loop uses when someone is watching: plain
   * `stream()` throws away the assembled message, so it cannot drive a turn
   * that might call a tool — and the loop never knows in advance whether a
   * turn will.
   */
  streamComplete?(request: CompletionRequest, onDelta: DeltaHandler): Promise<CompletionResult>;
  stream?(request: CompletionRequest): AsyncIterable<CompletionChunk>;
  listModels?(): Promise<ModelInfo[]>;
}
