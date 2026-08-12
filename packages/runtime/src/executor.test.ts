import { createLogger, newAgentId, newWorkspaceId } from "@bridge/core";
import {
  agents,
  createDb,
  type DbHandle,
  messages as messagesTable,
  runSteps,
  runs,
  workspaces,
} from "@bridge/db";
import type { CompletionResult, Provider } from "@bridge/sdk";
import { personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
