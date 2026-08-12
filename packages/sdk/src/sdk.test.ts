import { evaluatePermission } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockProvider } from "./mock-provider.js";
import type { BridgeTool, ToolContext } from "./tool.js";

describe("MockProvider", () => {
  it("completes with usage accounting", async () => {
    const provider = new MockProvider();
    const result = await provider.complete({
      model: "mock-1",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(result.message.content).toBe("mock: ping");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.stopReason).toBe("end");
  });

  it("streams chunks", async () => {
    const provider = new MockProvider("one two three");
    let text = "";
    for await (const chunk of provider.stream({ model: "mock-1", messages: [] })) {
      text += chunk.delta;
    }
    expect(text.trim()).toBe("one two three");
  });
});

describe("BridgeTool contract", () => {
  const echoTool: BridgeTool<{ text: string }> = {
    name: "echo",
    description: "Echoes input.",
    inputSchema: z.object({ text: z.string() }),
    actions: [{ name: "echo" }],
    async execute(input, ctx) {
      if (ctx.checkPermission("echo") !== "allow") {
        return { ok: false, output: null, error: "permission denied" };
      }
      return { ok: true, output: input.text };
    },
  };

  const ctx = (effect: "allow" | "deny"): ToolContext => ({
    workspaceId: "ws_1",
    agentId: "agt_1",
    runId: "run_1",
    log: () => {},
    checkPermission: (action) =>
      evaluatePermission(
        { default: "ask", rules: [{ resource: "tool:echo", actions: "*", effect }] },
        "tool:echo",
        action,
      ),
  });

  it("executes when permitted", async () => {
    const result = await echoTool.execute({ text: "hi" }, ctx("allow"));
    expect(result).toEqual({ ok: true, output: "hi" });
  });

  it("refuses when denied — permissions flow through context", async () => {
    const result = await echoTool.execute({ text: "hi" }, ctx("deny"));
    expect(result.ok).toBe(false);
  });
});
