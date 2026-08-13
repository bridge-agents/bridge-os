import { createLogger } from "@bridge/core";
import { RunExecutor } from "@bridge/runtime";
import type { CompletionResult, DeltaHandler, Provider } from "@bridge/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

const silentLogger = createLogger("test");
silentLogger.level = "silent";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let ws: string;
let agentId: string;

/** A provider that streams its answer one word at a time. */
function streamingProvider(text: string): Provider {
  return {
    id: "openai-compatible",
    async complete(): Promise<CompletionResult> {
      return {
        message: { role: "assistant", content: text },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end",
        model: "local",
      };
    },
    async streamComplete(_request, onDelta: DeltaHandler): Promise<CompletionResult> {
      for (const word of text.split(" ")) onDelta(`${word} `);
      return {
        message: { role: "assistant", content: text },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end",
        model: "local",
      };
    },
  };
}

/** Reads an SSE response into `{event, data}` records. */
async function readEvents(response: Response | Promise<Response>) {
  const resolved = await response;
  const text = await resolved.text();
  const events: { event: string; data: Record<string, unknown> }[] = [];

  for (const frame of text.split("\n\n")) {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1];
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  ws = user.workspaceId;

  await api(`/v1/workspaces/${ws}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "openai-compatible", baseUrl: "http://localhost:9/v1" }),
  });

  const created = await api(`/v1/workspaces/${ws}/agents`, {
    method: "POST",
    body: JSON.stringify({
      manifest: {
        specVersion: 1,
        meta: { name: "Talker", slug: "talker" },
        models: { default: { provider: "openai-compatible", model: "local" } },
        agents: [{ name: "main", instructions: "Chat with the user." }],
        entryAgent: "main",
      },
    }),
  });
  agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  await api(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" });
});
afterEach(async () => {
  await ctx.close();
});

const startRun = async () => {
  const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
    method: "POST",
    body: JSON.stringify({ input: "say hello" }),
  });
  return ((await res.json()) as { run: { id: string } }).run.id;
};

describe("run stream", () => {
  it("delivers deltas, steps and a terminal status", async () => {
    const runId = await startRun();
    const executor = new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => streamingProvider("Hello there friend"),
      dataDir: ctx.dataDir,
    });

    // Run and watch concurrently: the stream must be open while work happens
    // for the in-process deltas to reach it.
    const [events] = await Promise.all([
      readEvents(api(`/v1/workspaces/${ws}/runs/${runId}/stream`)),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await executor.runOnce();
      })(),
    ]);

    const deltas = events.filter((event) => event.event === "delta");
    expect(
      deltas
        .map((event) => event.data.text)
        .join("")
        .trim(),
    ).toBe("Hello there friend");

    const steps = events.filter((event) => event.event === "step");
    expect(steps.map((event) => event.data.type)).toEqual(["model_call"]);

    const final = events.filter((event) => event.event === "status").at(-1);
    expect(final?.data.status).toBe("succeeded");
    expect(final?.data.output).toMatchObject({ content: "Hello there friend" });
    expect(events.at(-1)?.event).toBe("done");
  });

  it("replays a finished run to a client that connects late", async () => {
    const runId = await startRun();
    await new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => streamingProvider("All done"),
      dataDir: ctx.dataDir,
    }).runOnce();

    // No deltas to catch — but the durable record still describes the run.
    const events = await readEvents(await api(`/v1/workspaces/${ws}/runs/${runId}/stream`));
    expect(events.filter((event) => event.event === "step")).toHaveLength(1);
    expect(events.find((event) => event.event === "status")?.data.status).toBe("succeeded");
    expect(events.at(-1)?.event).toBe("done");
  });

  it("closes the stream when a run parks for approval", async () => {
    // Rebuild the agent with a tool that needs approval.
    const created = await api(`/v1/workspaces/${ws}/agents`, {
      method: "POST",
      body: JSON.stringify({
        manifest: {
          specVersion: 1,
          meta: { name: "Writer", slug: "writer" },
          models: { default: { provider: "openai-compatible", model: "local" } },
          agents: [{ name: "main", instructions: "Write files.", tools: ["filesystem"] }],
          entryAgent: "main",
          tools: [{ name: "filesystem", kind: "native" }],
          permissions: { default: "ask", rules: [] },
        },
      }),
    });
    const writerId = ((await created.json()) as { agent: { id: string } }).agent.id;
    await api(`/v1/workspaces/${ws}/agents/${writerId}/deploy`, { method: "POST" });

    const res = await api(`/v1/workspaces/${ws}/agents/${writerId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "write a file" }),
    });
    const runId = ((await res.json()) as { run: { id: string } }).run.id;

    const asking: Provider = {
      id: "openai-compatible",
      async complete(): Promise<CompletionResult> {
        return {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "c1",
                name: "filesystem",
                arguments: { operation: "write", path: "a.txt", content: "x" },
              },
            ],
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
          model: "local",
        };
      },
    };

    const [events] = await Promise.all([
      readEvents(api(`/v1/workspaces/${ws}/runs/${runId}/stream`)),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await new RunExecutor({
          db: ctx.handle.db,
          logger: silentLogger,
          getProvider: async () => asking,
          dataDir: ctx.dataDir,
        }).runOnce();
      })(),
    ]);

    // The stream ends rather than hanging: the client switches to approvals.
    expect(events.filter((event) => event.event === "status").at(-1)?.data.status).toBe(
      "waiting_approval",
    );
    expect(events.at(-1)?.event).toBe("done");
  });

  it("refuses to stream another tenant's run", async () => {
    const runId = await startRun();
    const mallory = as(ctx.app, await signUp(ctx.app, "mallory@example.com"));
    expect((await mallory(`/v1/workspaces/${ws}/runs/${runId}/stream`)).status).toBe(404);
  });
});
