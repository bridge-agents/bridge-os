import { createLogger } from "@bridge/core";
import { runs } from "@bridge/db";
import { RunExecutor } from "@bridge/runtime";
import type { Provider } from "@bridge/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

const silentLogger = createLogger("test");
silentLogger.level = "silent";

/** Stands in for a real provider so the loop runs offline. */
const stubProvider: Provider = {
  id: "anthropic",
  async complete() {
    return {
      message: { role: "assistant", content: "A bridge spans a gap." },
      usage: { inputTokens: 1200, outputTokens: 40 },
      stopReason: "end",
      model: "claude-sonnet-5",
    };
  },
};

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let ws: string;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  ws = user.workspaceId;

  const created = await api(`/v1/workspaces/${ws}/agents`, {
    method: "POST",
    body: JSON.stringify({ templateId: "personal-assistant", name: "Assistant" }),
  });
  agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
});
afterEach(async () => {
  await ctx.close();
});

const connectAnthropic = () =>
  api(`/v1/workspaces/${ws}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key-value" }),
  });

describe("agent lifecycle", () => {
  it("refuses to deploy until the required providers are connected", async () => {
    const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/anthropic/);
  });

  it("deploys once the provider is connected, and stops again", async () => {
    await connectAnthropic();

    const deployed = await api(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" });
    expect(deployed.status).toBe(200);
    expect((await deployed.json()) as unknown).toMatchObject({
      agent: { status: "deployed" },
    });

    const stopped = await api(`/v1/workspaces/${ws}/agents/${agentId}/stop`, { method: "POST" });
    expect((await stopped.json()) as unknown).toMatchObject({ agent: { status: "stopped" } });
  });

  it("will not accept work for a stopped agent", async () => {
    await connectAnthropic();
    await api(`/v1/workspaces/${ws}/agents/${agentId}/stop`, { method: "POST" });

    const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "hello" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("runs", () => {
  it("queues a run and opens a conversation for it", async () => {
    const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "summarize my day" }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      run: { id: string; status: string; conversationId: string };
    };
    expect(body.run.status).toBe("queued");
    expect(body.run.id).toMatch(/^run_/);
    expect(body.run.conversationId).toMatch(/^cnv_/);

    const list = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`);
    expect(((await list.json()) as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it("reuses an existing conversation when asked", async () => {
    const first = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "one" }),
      })
    ).json()) as { run: { conversationId: string } };

    const second = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "two", conversationId: first.run.conversationId }),
      })
    ).json()) as { run: { conversationId: string } };

    expect(second.run.conversationId).toBe(first.run.conversationId);

    const conversations = await api(`/v1/workspaces/${ws}/agents/${agentId}/conversations`);
    expect(
      ((await conversations.json()) as { conversations: unknown[] }).conversations,
    ).toHaveLength(1);
  });

  it("rejects a conversation from another agent's workspace", async () => {
    const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "hi", conversationId: "cnv_nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns a run with its trace", async () => {
    const created = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "hello" }),
      })
    ).json()) as { run: { id: string } };

    const res = await api(`/v1/workspaces/${ws}/runs/${created.run.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { run: { status: string }; steps: unknown[] };
    expect(body.run.status).toBe("queued");
    expect(body.steps).toEqual([]);
  });

  it("cancels a queued run immediately", async () => {
    const created = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "hello" }),
      })
    ).json()) as { run: { id: string } };

    const res = await api(`/v1/workspaces/${ws}/runs/${created.run.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);

    const [row] = await ctx.handle.db.select().from(runs).where(eq(runs.id, created.run.id));
    expect(row?.status).toBe("cancelled");
    expect(row?.cancelRequested).toBe(true);
  });

  it("404s an unknown run", async () => {
    expect((await api(`/v1/workspaces/${ws}/runs/run_missing`)).status).toBe(404);
  });
});

describe("end to end", () => {
  it("creates, deploys, runs an agent and returns the answer with a trace", async () => {
    await connectAnthropic();
    await api(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" });

    const started = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "what is a bridge?" }),
      })
    ).json()) as { run: { id: string; conversationId: string } };

    // The executor is what the API hosts in embedded mode; drive it directly here.
    const executor = new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => stubProvider,
    });
    expect(await executor.runOnce()).toBe(true);

    const detail = (await (await api(`/v1/workspaces/${ws}/runs/${started.run.id}`)).json()) as {
      run: { status: string; output: { content: string }; inputTokens: number; costUsd: string };
      steps: { type: string }[];
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.output.content).toBe("A bridge spans a gap.");
    expect(detail.run.inputTokens).toBe(1200);
    expect(Number(detail.run.costUsd)).toBeGreaterThan(0);
    expect(detail.steps.map((step) => step.type)).toEqual(["model_call"]);

    // The exchange is now readable as conversation history.
    const conversation = (await (
      await api(`/v1/workspaces/${ws}/conversations/${started.run.conversationId}`)
    ).json()) as { messages: { role: string; content: string }[] };

    expect(conversation.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "what is a bridge?"],
      ["assistant", "A bridge spans a gap."],
    ]);
  });

  it("records a cancelled run as cancelled, not failed", async () => {
    await connectAnthropic();
    await api(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" });

    const started = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "long task" }),
      })
    ).json()) as { run: { id: string } };

    // Cancel while it is still queued, then let the executor observe the flag.
    await ctx.handle.db
      .update(runs)
      .set({ status: "queued", cancelRequested: true })
      .where(eq(runs.id, started.run.id));

    await new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => stubProvider,
    }).runOnce();

    const [row] = await ctx.handle.db.select().from(runs).where(eq(runs.id, started.run.id));
    expect(row?.status).toBe("cancelled");
  });
});

describe("run isolation", () => {
  it("hides runs, conversations and lifecycle actions from other tenants", async () => {
    const created = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "secret task" }),
      })
    ).json()) as { run: { id: string; conversationId: string } };

    const mallory = as(ctx.app, await signUp(ctx.app, "mallory@example.com"));

    expect((await mallory(`/v1/workspaces/${ws}/runs/${created.run.id}`)).status).toBe(404);
    expect(
      (await mallory(`/v1/workspaces/${ws}/conversations/${created.run.conversationId}`)).status,
    ).toBe(404);
    expect(
      (await mallory(`/v1/workspaces/${ws}/runs/${created.run.id}/cancel`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await mallory(`/v1/workspaces/${ws}/agents/${agentId}/deploy`, { method: "POST" })).status,
    ).toBe(404);
  });
});
