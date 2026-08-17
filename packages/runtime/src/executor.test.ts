import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, newAgentId, newWorkspaceId } from "@bridge/core";
import {
  agents,
  approvals,
  attachments,
  createDb,
  type DbHandle,
  messages as messagesTable,
  runSteps,
  runs,
  workspaces,
} from "@bridge/db";
import type { ChatMessage, CompletionResult, Provider } from "@bridge/sdk";
import { personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expirePendingApprovals } from "./approval-expiry.js";
import { createConversation, enqueueRun, RunExecutor } from "./executor.js";

let handle: DbHandle;
let workspaceId: string;
let agentId: string;

const logger = createLogger("test");
logger.level = "silent";

function provider(reply: Partial<CompletionResult> = {}): Provider {
  return {
    id: "anthropic",
    async complete() {
      return {
        message: reply.message ?? { role: "assistant", content: "the answer" },
        usage: reply.usage ?? { inputTokens: 1000, outputTokens: 500 },
        stopReason: reply.stopReason ?? "end",
        model: reply.model ?? "claude-sonnet-5",
      };
    },
  };
}

type Message = CompletionResult["message"];

/** Plays a fixed sequence of model replies, repeating the last one. */
function scripted(turns: Message[]): Provider {
  let call = 0;
  return {
    id: "anthropic",
    async complete() {
      const message = turns[Math.min(call++, turns.length - 1)] as Message;
      return {
        message,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: message.toolCalls?.length ? "tool_use" : "end",
      };
    },
  };
}

const writeCall = (id: string, path: string, content: string, encoding?: "base64"): Message => ({
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      name: "filesystem",
      arguments: { operation: "write", path, content, ...(encoding ? { encoding } : {}) },
    },
  ],
});

/** An agent with one native tool and nothing else. */
async function agentWithTool(
  tool: string,
  rules: { resource: string; actions: string[]; effect: "allow" | "deny" | "ask" }[],
) {
  const manifest = structuredClone(personalAssistantTemplate.manifest);
  const entry = manifest.agents.find((agent) => agent.name === manifest.entryAgent);
  if (!entry) throw new Error("entry agent missing");
  entry.tools = [tool];
  entry.canDelegateTo = [];
  manifest.agents = [entry];
  manifest.tools = [{ name: tool, kind: "native", config: {} }];
  manifest.permissions = { default: "ask", rules };
  await handle.db.update(agents).set({ manifest }).where(eq(agents.id, agentId));
}

const filesystemAgent = (
  rules: { resource: string; actions: string[]; effect: "allow" | "deny" | "ask" }[],
) => agentWithTool("filesystem", rules);

function executor(p: Provider = provider(), overrides = {}) {
  return new RunExecutor({
    db: handle.db,
    logger,
    getProvider: async () => p,
    ...overrides,
  });
}

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();

  workspaceId = newWorkspaceId();
  agentId = newAgentId();
  await handle.db.insert(workspaces).values({ id: workspaceId, name: "Test" });
  await handle.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: "Assistant",
    slug: "assistant",
    specVersion: SPEC_VERSION,
    manifest: personalAssistantTemplate.manifest,
    status: "deployed",
  });
}, 60_000);

afterEach(async () => {
  await handle?.close();
});

const getRun = async (runId: string) =>
  (await handle.db.select().from(runs).where(eq(runs.id, runId)))[0];

describe("run execution", () => {
  it("executes a queued run and records usage, cost and trace", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hello" });

    expect(await executor().runOnce()).toBe(true);

    const run = await getRun(runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.output).toMatchObject({ content: "the answer" });
    expect(run?.inputTokens).toBe(1000);
    expect(run?.outputTokens).toBe(500);
    // claude-sonnet-5: $3/M in, $15/M out → 0.003 + 0.0075
    expect(Number(run?.costUsd)).toBeCloseTo(0.0105, 6);
    expect(run?.startedAt).toBeTruthy();
    expect(run?.finishedAt).toBeTruthy();

    const steps = await handle.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.type).toBe("model_call");
  });

  it("leaves cost null when the model has no published price", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    await executor(provider({ model: "some-unlisted-model" })).runOnce();

    expect((await getRun(runId))?.costUsd).toBeNull();
  });

  it("returns false when nothing is queued", async () => {
    expect(await executor().runOnce()).toBe(false);
  });

  it("appends the turn to its conversation", async () => {
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    await enqueueRun(handle.db, { workspaceId, agentId, conversationId, text: "hello" });
    await executor().runOnce();

    const history = await handle.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId));

    expect(history.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello"],
      ["assistant", "the answer"],
    ]);
  });

  it("persists files generated by an agent with the assistant message", async () => {
    await filesystemAgent([{ resource: "tool:filesystem", actions: ["write"], effect: "allow" }]);

    const generating = scripted([
      writeCall("write-report", "report.txt", "generated report"),
      { role: "assistant", content: "The report is attached." },
    ]);
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-artifacts-"));
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    const runId = await enqueueRun(handle.db, {
      workspaceId,
      agentId,
      conversationId,
      text: "Create a report",
    });

    await executor(generating, { dataDir, attachmentDataDir: dataDir }).runOnce();

    const completedRun = await getRun(runId);
    expect(completedRun?.error).toBeNull();
    expect(completedRun).toMatchObject({ status: "succeeded" });
    const generatedSteps = await handle.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(generatedSteps.find((step) => step.type === "tool_call")?.data).toMatchObject({
      executed: true,
      ok: true,
      output: { path: "report.txt" },
    });
    const [artifact] = await handle.db
      .select()
      .from(attachments)
      .where(eq(attachments.runId, runId));
    expect(artifact).toMatchObject({
      conversationId,
      name: "report.txt",
      mimeType: "text/plain",
    });
    expect(await readFile(artifact?.storagePath ?? "", "utf8")).toBe("generated report");
    expect((await getRun(runId))?.output).toMatchObject({
      attachments: [expect.objectContaining({ id: artifact?.id, name: "report.txt" })],
    });
    // Bound to the answer, not to the question.
    const [assistantMessage] = await handle.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.role, "assistant"));
    expect(artifact?.messageId).toBe(assistantMessage?.id);
  });

  it("attaches an image an agent wrote into a folder outside its own workspace", async () => {
    const folder = await mkdtemp(join(tmpdir(), "bridge-allowed-"));
    await handle.db
      .update(workspaces)
      .set({ allowedPaths: [folder] })
      .where(eq(workspaces.id, workspaceId));
    await filesystemAgent([
      {
        resource: "tool:filesystem",
        actions: ["write", "reach-outside-workspace"],
        effect: "allow",
      },
    ]);

    // A one-pixel PNG: bytes, which only survive as base64.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-artifacts-"));
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    const runId = await enqueueRun(handle.db, {
      workspaceId,
      agentId,
      conversationId,
      text: "Save a chart to my folder",
    });

    await executor(
      scripted([
        writeCall("write-chart", join(folder, "chart.png"), png, "base64"),
        { role: "assistant", content: "Saved." },
      ]),
      { dataDir, attachmentDataDir: dataDir },
    ).runOnce();

    expect(await getRun(runId)).toMatchObject({ status: "succeeded" });
    const [artifact] = await handle.db
      .select()
      .from(attachments)
      .where(eq(attachments.runId, runId));
    expect(artifact).toMatchObject({ name: "chart.png", mimeType: "image/png" });
    expect(await readFile(artifact?.storagePath ?? "")).toEqual(Buffer.from(png, "base64"));
    // The file the user asked for is where they asked for it, too.
    expect(await readFile(join(folder, "chart.png"))).toEqual(Buffer.from(png, "base64"));
  });

  it("draws without being granted a tool or asking permission", async () => {
    // No image grant, and the default policy asks about everything.
    await agentWithTool("filesystem", []);

    const png = Buffer.from("pretend png bytes").toString("base64");
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-artifacts-"));
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    const runId = await enqueueRun(handle.db, {
      workspaceId,
      agentId,
      conversationId,
      text: "draw me a bridge",
    });

    await executor(
      scripted([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "draw", name: "image", arguments: { prompt: "a bridge at dusk" } }],
        },
        { role: "assistant", content: "Here is the bridge." },
      ]),
      {
        dataDir,
        attachmentDataDir: dataDir,
        image: {
          endpoint: "https://api.openai.example/v1",
          apiKey: "k",
          fetchImpl: async () =>
            new Response(JSON.stringify({ data: [{ b64_json: png }] }), {
              headers: { "content-type": "application/json" },
            }),
        },
      },
    ).runOnce();

    expect(await getRun(runId)).toMatchObject({ status: "succeeded" });
    const [picture] = await handle.db
      .select()
      .from(attachments)
      .where(eq(attachments.runId, runId));
    expect(picture).toMatchObject({ name: "image-1.png", mimeType: "image/png", conversationId });
    expect(await readFile(picture?.storagePath ?? "")).toEqual(Buffer.from(png, "base64"));

    // On the reply, which is what the chat renders inline.
    const [reply] = await handle.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.role, "assistant"));
    expect(picture?.messageId).toBe(reply?.id);
    expect((await getRun(runId))?.output).toMatchObject({
      attachments: [expect.objectContaining({ name: "image-1.png", mimeType: "image/png" })],
    });
  });

  it("keeps a file the agent wrote before the run paused for an approval", async () => {
    const folder = await mkdtemp(join(tmpdir(), "bridge-ask-"));
    await handle.db
      .update(workspaces)
      .set({ allowedPaths: [folder] })
      .where(eq(workspaces.id, workspaceId));
    // "write" is allowed outright; reaching outside the workspace still asks.
    await filesystemAgent([{ resource: "tool:filesystem", actions: ["write"], effect: "allow" }]);

    const dataDir = await mkdtemp(join(tmpdir(), "bridge-artifacts-"));
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    const runId = await enqueueRun(handle.db, {
      workspaceId,
      agentId,
      conversationId,
      text: "Write both files",
    });

    /**
     * Two calls in one turn: the first lands, the second reaches outside the
     * workspace and has to be approved. The run stops in between.
     */
    const outside = join(folder, "second.txt");
    const both: Message = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "first",
          name: "filesystem",
          arguments: { operation: "write", path: "first.txt", content: "one" },
        },
        {
          id: "second",
          name: "filesystem",
          arguments: { operation: "write", path: outside, content: "two" },
        },
      ],
    };
    const exec = executor(scripted([both, { role: "assistant", content: "Both written." }]), {
      dataDir,
      attachmentDataDir: dataDir,
    });

    await exec.runOnce();
    expect(await getRun(runId)).toMatchObject({ status: "waiting_approval" });
    const parked = await handle.db.select().from(attachments).where(eq(attachments.runId, runId));
    expect(parked.map((row) => row.name)).toEqual(["first.txt"]);

    // Approve, and let the run pick up where it stopped.
    await handle.db.update(approvals).set({ status: "approved" }).where(eq(approvals.runId, runId));
    await handle.db.update(runs).set({ status: "queued" }).where(eq(runs.id, runId));
    await exec.runOnce();

    expect(await getRun(runId)).toMatchObject({ status: "succeeded" });
    const saved = await handle.db.select().from(attachments).where(eq(attachments.runId, runId));
    expect(saved.map((row) => row.name).sort()).toEqual(["first.txt", "second.txt"]);
    const [assistantMessage] = await handle.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.role, "assistant"));
    // Including the one written before the pause: it is the agent's answer.
    expect(saved.every((row) => row.messageId === assistantMessage?.id)).toBe(true);
    expect((await getRun(runId))?.output).toMatchObject({
      attachments: [
        expect.objectContaining({ name: "first.txt" }),
        expect.objectContaining({ name: "second.txt" }),
      ],
    });
  });

  it("starts a queued run at once rather than waiting for the next poll", async () => {
    const exec = executor();
    // A poll interval far longer than this test: only the wake-up can explain
    // the run finishing, which is the point.
    exec.start(60_000);
    try {
      const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hello" });
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        if ((await getRun(runId))?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await getRun(runId)).toMatchObject({ status: "succeeded" });
    } finally {
      await exec.stop();
    }
  });

  it("shows the model a window of the conversation, not all of it", async () => {
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    for (let turn = 0; turn < 12; turn += 1) {
      await enqueueRun(handle.db, {
        workspaceId,
        agentId,
        conversationId,
        text: `message ${turn}`,
      });
      await executor().runOnce();
    }

    let seen: ChatMessage[] = [];
    const capturing: Provider = {
      id: "anthropic",
      async complete(request) {
        seen = request.messages;
        return {
          message: { role: "assistant", content: "ok" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end",
        };
      },
    };
    await enqueueRun(handle.db, { workspaceId, agentId, conversationId, text: "and now" });
    await executor(capturing, { historyTurns: 6 }).runOnce();

    const replayed = seen.filter((message) => message.role !== "system");
    // Six of history plus this run's own prompt — not twenty-five.
    expect(replayed).toHaveLength(7);
    expect(replayed.at(-1)?.content).toBe("and now");
    expect(replayed.some((message) => message.content === "message 0")).toBe(false);
  });

  it("does not re-upload every file in the conversation on every message", async () => {
    const conversationId = await createConversation(handle.db, { workspaceId, agentId });
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-history-"));

    // An early turn carrying a file.
    const firstRun = await enqueueRun(handle.db, {
      workspaceId,
      agentId,
      conversationId,
      text: "here is a picture",
    });
    const storagePath = join(dataDir, "old.png");
    await writeFile(storagePath, Buffer.from("an old picture"));
    await handle.db.insert(attachments).values({
      id: "att_old",
      workspaceId,
      conversationId,
      runId: firstRun,
      name: "old.png",
      mimeType: "image/png",
      sizeBytes: 14,
      storagePath,
    });
    await executor(provider(), { dataDir, attachmentDataDir: dataDir }).runOnce();

    // Several turns later, that file is no longer worth resending.
    for (const text of ["one", "two", "three"]) {
      await enqueueRun(handle.db, { workspaceId, agentId, conversationId, text });
      await executor(provider(), { dataDir, attachmentDataDir: dataDir }).runOnce();
    }

    let seen: ChatMessage[] = [];
    const capturing: Provider = {
      id: "anthropic",
      async complete(request) {
        seen = request.messages;
        return {
          message: { role: "assistant", content: "ok" },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end",
        };
      },
    };
    await enqueueRun(handle.db, { workspaceId, agentId, conversationId, text: "still there?" });
    await executor(capturing, { dataDir, attachmentDataDir: dataDir }).runOnce();

    expect(seen.some((message) => message.attachments?.length)).toBe(false);
  });

  it("stops a run that was asked to cancel", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    await handle.db.update(runs).set({ cancelRequested: true }).where(eq(runs.id, runId));

    await executor().runOnce();
    expect((await getRun(runId))?.status).toBe("cancelled");
  });

  it("takes queued runs with it when the agent is deleted", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    await handle.db.delete(agents).where(eq(agents.id, agentId));

    // Runs cascade with their agent; the audit log in `events` outlives both.
    expect(await getRun(runId)).toBeUndefined();
    expect(await executor().runOnce()).toBe(false);
  });

  it("retries a failing run before giving up", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    const exploding: Provider = {
      id: "anthropic",
      async complete() {
        throw new Error("provider exploded");
      },
    };
    const exec = executor(exploding, { maxAttempts: 2 });

    await exec.runOnce();
    expect((await getRun(runId))?.status).toBe("queued"); // retryable

    await exec.runOnce();
    const run = await getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/provider exploded/);
  });
});

describe("approval expiry", () => {
  it("turns an overdue approval into a denial and releases the parked run", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "write a file" });
    await handle.db.update(runs).set({ status: "waiting_approval" }).where(eq(runs.id, runId));
    await handle.db.insert(approvals).values({
      id: "apr_expired",
      workspaceId,
      runId,
      agentId,
      agentName: "main",
      toolName: "filesystem",
      action: "write",
      input: { path: "report.txt" },
      status: "pending",
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await expirePendingApprovals(handle.db)).toBe(1);
    expect((await getRun(runId))?.status).toBe("queued");
    const [approval] = await handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, "apr_expired"));
    expect(approval).toMatchObject({
      status: "expired",
      reason: expect.stringContaining("expired"),
    });
  });
});

describe("crash recovery", () => {
  it("requeues a run whose worker stopped heartbeating", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    // Simulate a worker that claimed the run and then died.
    await handle.db
      .update(runs)
      .set({
        status: "running",
        attempt: 1,
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      })
      .where(eq(runs.id, runId));

    const exec = executor();
    expect(await exec.reclaimStale()).toBe(1);
    expect((await getRun(runId))?.status).toBe("queued");

    // A fresh worker then completes it.
    expect(await exec.runOnce()).toBe(true);
    expect((await getRun(runId))?.status).toBe("succeeded");
  });

  it("does not disturb a run that is still heartbeating", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    await handle.db
      .update(runs)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(runs.id, runId));

    expect(await executor().reclaimStale()).toBe(0);
    expect((await getRun(runId))?.status).toBe("running");
  });

  it("fails a run that keeps being abandoned", async () => {
    const runId = await enqueueRun(handle.db, { workspaceId, agentId, text: "hi" });
    await handle.db
      .update(runs)
      .set({ status: "running", attempt: 3, heartbeatAt: new Date(0) })
      .where(eq(runs.id, runId));

    await executor(provider(), { maxAttempts: 3 }).reclaimStale();
    const run = await getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/abandoned/);
  });
});

describe("claiming", () => {
  it("never hands the same run to two workers", async () => {
    await enqueueRun(handle.db, { workspaceId, agentId, text: "one" });

    const a = executor();
    const b = executor();
    const [first, second] = await Promise.all([a.runOnce(), b.runOnce()]);

    // Exactly one worker got the single queued run.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const all = await handle.db.select().from(runs);
    expect(all).toHaveLength(1);
    expect(all[0]?.attempt).toBe(1);
  });

  it("drains the queue in order", async () => {
    for (const text of ["a", "b", "c"]) {
      await enqueueRun(handle.db, { workspaceId, agentId, text });
    }
    const exec = executor();
    while (await exec.runOnce()) {
      /* drain */
    }

    const all = await handle.db.select().from(runs);
    expect(all.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("honors each agent's maxConcurrentRuns limit", async () => {
    const activeId = await enqueueRun(handle.db, { workspaceId, agentId, text: "active" });
    const queuedId = await enqueueRun(handle.db, { workspaceId, agentId, text: "queued" });
    await handle.db
      .update(runs)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(runs.id, activeId));

    expect(await executor().runOnce()).toBe(false);
    expect((await getRun(queuedId))?.status).toBe("queued");

    await handle.db
      .update(runs)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(runs.id, activeId));
    expect(await executor().runOnce()).toBe(true);
    expect((await getRun(queuedId))?.status).toBe("succeeded");
  });

  it("stops before another model call when the daily token budget is exhausted", async () => {
    const manifest = structuredClone(personalAssistantTemplate.manifest);
    manifest.runtime.limits.dailyTokenBudget = 1_000;
    await handle.db.update(agents).set({ manifest }).where(eq(agents.id, agentId));

    const spentId = await enqueueRun(handle.db, { workspaceId, agentId, text: "spent" });
    await handle.db
      .update(runs)
      .set({
        status: "succeeded",
        inputTokens: 800,
        outputTokens: 200,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, spentId));
    const nextId = await enqueueRun(handle.db, { workspaceId, agentId, text: "next" });
    let calls = 0;
    const counting = provider();
    const original = counting.complete.bind(counting);
    counting.complete = async (request) => {
      calls += 1;
      return original(request);
    };

    expect(await executor(counting).runOnce()).toBe(true);
    expect(calls).toBe(0);
    expect((await getRun(nextId))?.status).toBe("failed");
  });
});
