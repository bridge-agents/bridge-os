import { createLogger } from "@bridge/core";
import { agents, runs } from "@bridge/db";
import { RunExecutor } from "@bridge/runtime";
import type { CompletionRequest, Provider } from "@bridge/sdk";
import type { Manifest } from "@bridge/spec";
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

  it("renames, pins, sorts, and deletes conversations", async () => {
    const first = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "first thread" }),
      })
    ).json()) as { run: { conversationId: string } };
    await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "newer thread" }),
    });

    const updated = await api(`/v1/workspaces/${ws}/conversations/${first.run.conversationId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Important work", pinned: true }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      conversation: { title: "Important work", pinned: true },
    });

    const list = (await (await api(`/v1/workspaces/${ws}/conversations`)).json()) as {
      conversations: { id: string; pinned: boolean }[];
    };
    expect(list.conversations[0]).toMatchObject({
      id: first.run.conversationId,
      pinned: true,
    });

    expect(
      (
        await api(`/v1/workspaces/${ws}/conversations/${first.run.conversationId}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (await api(`/v1/workspaces/${ws}/conversations/${first.run.conversationId}`)).status,
    ).toBe(404);
  });

  it("rejects a conversation from another agent's workspace", async () => {
    const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "hi", conversationId: "cnv_nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a conversation owned by another agent in the same workspace", async () => {
    const first = (await (
      await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "one" }),
      })
    ).json()) as { run: { conversationId: string } };
    const created = await api(`/v1/workspaces/${ws}/agents`, {
      method: "POST",
      body: JSON.stringify({ templateId: "personal-assistant", name: "Other assistant" }),
    });
    const otherAgentId = ((await created.json()) as { agent: { id: string } }).agent.id;

    const res = await api(`/v1/workspaces/${ws}/agents/${otherAgentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "two", conversationId: first.run.conversationId }),
    });
    expect(res.status).toBe(404);
  });

  it("uploads a file, binds it to the run, and delivers model options and bytes", async () => {
    await connectAnthropic();
    const form = new FormData();
    form.append("file", new File(["load rating: 42"], "notes.txt", { type: "text/plain" }));
    const uploaded = await api(`/v1/workspaces/${ws}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const attachment = (await uploaded.json()) as {
      attachment: { id: string; name: string; sizeBytes: number };
    };

    const started = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        input: "use the attached notes",
        attachmentIds: [attachment.attachment.id],
        model: { provider: "anthropic", model: "claude-opus-test" },
        reasoningEffort: "high",
        fastMode: true,
      }),
    });
    if (started.status !== 201)
      throw new Error(`start failed: ${started.status} ${await started.text()}`);
    const run = (await started.json()) as { run: { id: string; conversationId: string } };

    let request: CompletionRequest | undefined;
    const capturing: Provider = {
      id: "anthropic",
      async complete(value) {
        request = value;
        return {
          message: { role: "assistant", content: "read it" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end",
          model: value.model,
        };
      },
    };
    await new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => capturing,
    }).runOnce();

    expect(request?.model).toBe("claude-opus-test");
    expect(request?.reasoningEffort).toBe("high");
    expect(request?.serviceTier).toBe("fast");
    expect(request?.messages.at(-1)?.attachments?.[0]).toMatchObject({
      id: attachment.attachment.id,
      name: "notes.txt",
      mimeType: "text/plain",
    });
    expect(
      Buffer.from(request?.messages.at(-1)?.attachments?.[0]?.dataBase64 ?? "", "base64").toString(
        "utf8",
      ),
    ).toBe("load rating: 42");

    const conversation = (await (
      await api(`/v1/workspaces/${ws}/conversations/${run.run.conversationId}`)
    ).json()) as { messages: { role: string; attachments: { id: string }[] }[] };
    expect(conversation.messages[0]?.attachments).toEqual([
      expect.objectContaining({ id: attachment.attachment.id }),
    ]);
    // The user's file belongs to the question alone; the reply made nothing.
    expect(conversation.messages[1]).toMatchObject({ role: "assistant", attachments: [] });
  });

  it("shows a file the agent wrote in the conversation, and serves its bytes", async () => {
    await connectAnthropic();
    const [agent] = await ctx.handle.db.select().from(agents).where(eq(agents.id, agentId));
    const manifest = structuredClone(agent?.manifest) as Manifest;
    const entry = manifest.agents.find((one) => one.name === manifest.entryAgent);
    if (!entry) throw new Error("entry agent missing");
    entry.tools = ["filesystem"];
    entry.canDelegateTo = [];
    manifest.agents = [entry];
    manifest.tools = [{ name: "filesystem", kind: "native", config: {} }];
    manifest.permissions = {
      default: "deny",
      rules: [{ resource: "tool:filesystem", actions: ["write"], effect: "allow" }],
    };
    await ctx.handle.db.update(agents).set({ manifest }).where(eq(agents.id, agentId));

    const started = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "write me a summary" }),
    });
    const run = (await started.json()) as { run: { id: string; conversationId: string } };

    let call = 0;
    const writing: Provider = {
      id: "anthropic",
      async complete() {
        call += 1;
        return {
          message:
            call === 1
              ? {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    {
                      id: "write-summary",
                      name: "filesystem",
                      arguments: {
                        operation: "write",
                        path: "summary.md",
                        content: "# Summary\n",
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "Here is the summary." },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: call === 1 ? "tool_use" : "end",
          model: "claude-sonnet-5",
        };
      },
    };
    await new RunExecutor({
      db: ctx.handle.db,
      logger: silentLogger,
      getProvider: async () => writing,
      dataDir: ctx.dataDir,
      attachmentDataDir: ctx.dataDir,
    }).runOnce();

    const conversation = (await (
      await api(`/v1/workspaces/${ws}/conversations/${run.run.conversationId}`)
    ).json()) as {
      messages: { role: string; attachments: { id: string; name: string; mimeType: string }[] }[];
    };
    const reply = conversation.messages.find((message) => message.role === "assistant");
    expect(reply?.attachments).toEqual([
      expect.objectContaining({ name: "summary.md", mimeType: "text/markdown" }),
    ]);

    // What the chat links to has to actually be downloadable.
    const file = await api(`/v1/workspaces/${ws}/attachments/${reply?.attachments[0]?.id}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("# Summary\n");
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

/**
 * Opening a conversation has to show what happened in it.
 *
 * The bug these close: a run that failed, or one still queued, wrote nothing
 * to the conversation — so opening it showed the same blank slate as a brand
 * new chat, and a scheduled run that crashed looked like it had never
 * happened at all.
 */
describe("what a conversation shows", () => {
  const open = async (conversationId: string) =>
    (await (await api(`/v1/workspaces/${ws}/conversations/${conversationId}`)).json()) as {
      runs: { id: string; status: string; error: string | null; trigger: string }[];
      messages: { role: string; content: string; runId: string | null }[];
    };

  const start = async (input: string) =>
    (
      (await (
        await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
          method: "POST",
          body: JSON.stringify({ input }),
        })
      ).json()) as { run: { id: string; conversationId: string } }
    ).run;

  it("holds the question before the answer exists", async () => {
    const run = await start("what happened overnight?");

    const { messages } = await open(run.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("what happened overnight?");
  });

  it("reports a run that failed, rather than looking empty", async () => {
    const run = await start("do the thing");
    await ctx.handle.db
      .update(runs)
      .set({ status: "failed", error: "provider unreachable" })
      .where(eq(runs.id, run.id));

    const conversation = await open(run.conversationId);
    // The question is there, and so is the reason there is no answer.
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.runs).toHaveLength(1);
    expect(conversation.runs[0]).toMatchObject({
      status: "failed",
      error: "provider unreachable",
    });
  });

  it("says how a run was started, so automated work is recognisable", async () => {
    const run = await start("scheduled work");
    await ctx.handle.db.update(runs).set({ trigger: "schedule" }).where(eq(runs.id, run.id));

    expect((await open(run.conversationId)).runs[0]?.trigger).toBe("schedule");
  });

  it("keeps runs in the order they were queued", async () => {
    const first = await start("one");
    await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
      method: "POST",
      body: JSON.stringify({ input: "two", conversationId: first.conversationId }),
    });

    const conversation = await open(first.conversationId);
    expect(conversation.runs).toHaveLength(2);
    expect(conversation.messages.map((message) => message.content)).toEqual(["one", "two"]);
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
