import type { CompletionChunk, CompletionRequest, CompletionResult, Provider } from "./provider.js";

/**
 * Deterministic provider for tests and offline development. Echoes the last
 * user message (or a canned reply) and reports approximate token usage.
 */
export class MockProvider implements Provider {
  readonly id = "mock";

  constructor(private readonly reply?: string) {}

  private respond(request: CompletionRequest): string {
    if (this.reply !== undefined) return this.reply;
    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    return lastUser ? `mock: ${lastUser.content}` : "mock: hello";
  }

  private usage(request: CompletionRequest, output: string) {
    const inputChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      inputTokens: Math.max(1, Math.ceil(inputChars / 4)),
      outputTokens: Math.max(1, Math.ceil(output.length / 4)),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const content = this.respond(request);
    return {
      message: { role: "assistant", content },
      usage: this.usage(request, content),
      stopReason: "end",
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
    for (const word of this.respond(request).split(" ")) {
      yield { delta: `${word} ` };
    }
  }
}
