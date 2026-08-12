import { MockProvider } from "@bridge/sdk";
import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { estimateCost, getModelPrice } from "./pricing.js";
import { createProvider, UnsupportedProviderError } from "./registry.js";

/** Records what the adapter actually put on the wire. */
const sent: { body?: WireBody; headers?: Record<string, string> } = {};

interface WireBody {
  messages: Record<string, unknown>[];
  tools?: { function: { name: string } }[];
}

/** Minimal fake of an OpenAI-compatible endpoint. */
function fakeEndpoint(payload: unknown, status = 200): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    sent.body = init?.body ? (JSON.parse(String(init.body)) as WireBody) : undefined;
    sent.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const textReply = {
  model: "gpt-5",
  choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
};

describe("OpenAiCompatibleProvider", () => {
  const provider = (payload: unknown, status?: number) =>
    new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://example.test/v1/",
      apiKey: "sk-test",
      fetchImpl: fakeEndpoint(payload, status),
    });

  it("returns normalized text and usage", async () => {
    const result = await provider(textReply).complete({
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.message.content).toBe("hello there");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(result.stopReason).toBe("end");
    expect(result.model).toBe("gpt-5");
  });

  it("normalizes tool calls and parses their JSON arguments", async () => {
    const result = await provider({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", function: { name: "search", arguments: '{"q":"bridge"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }).complete({ model: "gpt-5", messages: [{ role: "user", content: "search" }] });

    expect(result.stopReason).toBe("tool_use");
    expect(result.message.toolCalls).toEqual([
      { id: "call_1", name: "search", arguments: { q: "bridge" } },
    ]);
  });

  it("survives malformed tool arguments instead of throwing", async () => {
    const result = await provider({
      choices: [
        {
          message: { tool_calls: [{ id: "c", function: { name: "x", arguments: "{oops" } }] },
          finish_reason: "tool_calls",
        },
      ],
    }).complete({ model: "gpt-5", messages: [] });

    expect(result.message.toolCalls?.[0]?.arguments).toEqual({});
  });

  it("maps finish reasons, including content filtering to refusal", async () => {
    for (const [finish, expected] of [
      ["stop", "end"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
      ["content_filter", "refusal"],
    ] as const) {
      const result = await provider({
        choices: [{ message: { content: "" }, finish_reason: finish }],
      }).complete({ model: "gpt-5", messages: [] });
      expect(result.stopReason).toBe(expected);
    }
  });

  it("raises a useful error on a failed request", async () => {
    await expect(
      provider({ error: { message: "bad key" } }, 401).complete({ model: "gpt-5", messages: [] }),
    ).rejects.toThrow(/401/);
  });

  it("sends tools and messages in the wire format", async () => {
    await provider(textReply).complete({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
        },
        { role: "tool", content: "result", toolCallId: "c1" },
      ],
      tools: [
        {
          name: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const body = sent.body;
    if (!body) throw new Error("no request captured");

    expect(body.tools?.[0]?.function.name).toBe("search");
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });

    const assistantTurn = body.messages[2] as {
      tool_calls: { function: { arguments: string } }[];
    };
    expect(assistantTurn.tool_calls[0]?.function.arguments).toBe('{"q":"x"}');
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
  });

  it("omits the authorization header when no key is configured (local runtimes)", async () => {
    const local = new OpenAiCompatibleProvider({
      id: "ollama",
      baseUrl: "http://localhost:11434/v1",
      fetchImpl: fakeEndpoint(textReply),
    });
    await local.complete({ model: "llama3", messages: [] });

    expect(sent.headers?.authorization).toBeUndefined();
  });
});

describe("createProvider", () => {
  it("builds adapters for known providers", () => {
    expect(createProvider({ provider: "anthropic", apiKey: "sk-ant" }).id).toBe("anthropic");
    expect(createProvider({ provider: "openai", apiKey: "sk" }).id).toBe("openai");
    expect(createProvider({ provider: "ollama" }).id).toBe("ollama");
    expect(createProvider({ provider: "openai-compatible", baseUrl: "http://x/v1" }).id).toBe(
      "openai-compatible",
    );
  });

  it("requires credentials where the provider needs them", () => {
    expect(() => createProvider({ provider: "anthropic" })).toThrow(/API key/);
    expect(() => createProvider({ provider: "openai" })).toThrow(/API key/);
  });

  it("rejects providers with no adapter and no base URL", () => {
    expect(() => createProvider({ provider: "google", apiKey: "k" })).toThrow(
      UnsupportedProviderError,
    );
  });
});

describe("cost estimation", () => {
  it("prices a known model from published rates", () => {
    const cost = estimateCost("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost).toBeCloseTo(5 + 2.5, 6);
  });

  it("returns undefined rather than guessing for unknown models", () => {
    expect(estimateCost("some-new-model", { inputTokens: 100, outputTokens: 100 })).toBeUndefined();
    expect(getModelPrice("some-new-model")).toBeUndefined();
  });
});

/** The contract every adapter must satisfy, exercised through the offline mock. */
describe("Provider contract", () => {
  it("MockProvider satisfies it", async () => {
    const result = await new MockProvider().complete({
      model: "mock-1",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(result.message.role).toBe("assistant");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(["end", "tool_use", "max_tokens", "refusal"]).toContain(result.stopReason);
  });
});
