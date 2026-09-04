import { createLogger } from "@bridge/core";
import { agents, runs } from "@bridge/db";
import { RunExecutor } from "@bridge/runtime";
import type { CompletionResult, Provider } from "@bridge/sdk";
import type { Manifest } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarise } from "./activity.js";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

const silent = createLogger("test");
silent.level = "silent";

type Message = CompletionResult["message"];

/** Plays a fixed sequence of replies, repeating the last one. */
function scripted(turns: Message[]): Provider {
  let call = 0;
  return {
    id: "anthropic",
    async complete() {
      const message = turns[Math.min(call++, turns.length - 1)] as Message;
      return {
        message,
        usage: { inputTokens: 1200, outputTokens: 300 },
        stopReason: message.toolCalls?.length ? "tool_use" : "end",
        model: "claude-sonnet-5",
      };
    },
  };
}

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
  await api(`/v1/workspaces/${ws}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key-value" }),
  });
  const created = await api(`/v1/workspaces/${ws}/agents`, {
    method: "POST",
    body: JSON.stringify({ templateId: "personal-assistant", name: "Assistant" }),
  });
  agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  await ctx.close();
});

/** Grants the filesystem tool so a run can produce real tool-call steps. */
async function allowFilesystem() {
  const [row] = await ctx.handle.db.select().from(agents).where(eq(agents.id, agentId));
  const manifest = structuredClone(row?.manifest) as Manifest;
  const entry = manifest.agents.find((one) => one.name === manifest.entryAgent);
  if (!entry) throw new Error("entry agent missing");
  entry.tools = ["filesystem"];
  entry.canDelegateTo = [];
  manifest.agents = [entry];
  manifest.tools = [{ name: "filesystem", kind: "native", config: {} }];
  manifest.permissions = {
    default: "deny",
    rules: [{ resource: "tool:filesystem", actions: ["write", "read"], effect: "allow" }],
  };
  await ctx.handle.db.update(agents).set({ manifest }).where(eq(agents.id, agentId));
}

const startRun = async (input: string) => {
  const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  return ((await res.json()) as { run: { id: string } }).run.id;
};

const execute = (provider: Provider) =>
  new RunExecutor({
    db: ctx.handle.db,
    logger: silent,
    getProvider: async () => provider,
    dataDir: ctx.dataDir,
    attachmentDataDir: ctx.dataDir,
  }).runOnce();

describe("the run list", () => {
  it("shows every agent's runs together, newest first", async () => {
    await startRun("one");
    await execute(scripted([{ role: "assistant", content: "done" }]));
    await startRun("two");
    await execute(scripted([{ role: "assistant", content: "done" }]));

    const { runs: rows } = (await (await api(`/v1/workspaces/${ws}/activity/runs`)).json()) as {
      runs: { id: string; agentName: string; costUsd: string | null }[];
    };

    expect(rows).toHaveLength(2);
    // The workspace view names the agent; a bare id explains nothing.
    expect(rows[0]?.agentName).toBe("Assistant");
    expect(rows[0]?.costUsd).not.toBeNull();
  });

  it("filters by status, so 'what broke' is one request", async () => {
    await startRun("fine");
    await execute(scripted([{ role: "assistant", content: "done" }]));

    const failing: Provider = {
      id: "anthropic",
      async complete() {
        throw new Error("provider exploded");
      },
    };
    const brokenId = await startRun("breaks");
    // Burn its attempts so it lands in `failed` rather than back on the queue.
    for (let attempt = 0; attempt < 4; attempt += 1) await execute(failing);

    const { runs: failed } = (await (
      await api(`/v1/workspaces/${ws}/activity/runs?status=failed`)
    ).json()) as { runs: { id: string; error: string | null }[] };

    expect(failed.map((run) => run.id)).toEqual([brokenId]);
    // "Why did it fail" is answerable from the list itself.
    expect(failed[0]?.error).toMatch(/provider exploded/);
  });

  it("pages with a cursor rather than an offset", async () => {
    for (const text of ["a", "b", "c"]) {
      await startRun(text);
      await execute(scripted([{ role: "assistant", content: "done" }]));
    }

    const first = (await (await api(`/v1/workspaces/${ws}/activity/runs?limit=2`)).json()) as {
      runs: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.runs).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = (await (
      await api(
        `/v1/workspaces/${ws}/activity/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      )
    ).json()) as { runs: { id: string }[]; nextCursor: string | null };

    expect(second.runs).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    // No row appears on both pages.
    const seen = [...first.runs, ...second.runs].map((run) => run.id);
    expect(new Set(seen).size).toBe(3);
  });

  it("keeps one workspace's runs out of another's", async () => {
    await startRun("mine");
    await execute(scripted([{ role: "assistant", content: "done" }]));

    const stranger = await signUp(ctx.app, "stranger@example.com");
    const theirs = (await (
      await as(ctx.app, stranger)(`/v1/workspaces/${stranger.workspaceId}/activity/runs`)
    ).json()) as { runs: unknown[] };
    expect(theirs.runs).toEqual([]);
  });
});

describe("one run's trace", () => {
  it("records every tool call exactly once, in order", async () => {
    await allowFilesystem();
    const runId = await startRun("write two files");
    await execute(
      scripted([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "one",
              name: "filesystem",
              arguments: { operation: "write", path: "a.txt", content: "a" },
            },
            {
              id: "two",
              name: "filesystem",
              arguments: { operation: "write", path: "b.txt", content: "b" },
            },
          ],
        },
        { role: "assistant", content: "Both written." },
      ]),
    );

    const body = (await (
      await api(`/v1/workspaces/${ws}/activity/runs/${runId}/activity`)
    ).json()) as {
      steps: {
        seq: number;
        type: string;
        data: { tool?: string; arguments?: { path?: string } };
      }[];
      summary: { toolCalls: number; modelCalls: number; tools: string[] };
    };

    const toolCalls = body.steps.filter((step) => step.type === "tool_call");
    expect(toolCalls).toHaveLength(2);
    // Exactly once each, and in the order the model asked for them.
    expect(toolCalls.map((step) => step.data.arguments?.path)).toEqual(["a.txt", "b.txt"]);
    expect(new Set(body.steps.map((step) => step.seq)).size).toBe(body.steps.length);
    expect(body.steps.map((step) => step.seq)).toEqual(
      [...body.steps.map((s) => s.seq)].sort((a, b) => a - b),
    );

    expect(body.summary).toMatchObject({ toolCalls: 2, modelCalls: 2, tools: ["filesystem"] });
  });

  it("answers what it cost and how long it took", async () => {
    const runId = await startRun("hello");
    await execute(scripted([{ role: "assistant", content: "hi" }]));

    const body = (await (
      await api(`/v1/workspaces/${ws}/activity/runs/${runId}/activity`)
    ).json()) as {
      run: { costUsd: string | null; inputTokens: number; outputTokens: number; status: string };
      summary: { durationMs: number | null };
    };

    expect(body.run.status).toBe("succeeded");
    expect(body.run.inputTokens).toBe(1200);
    expect(body.run.outputTokens).toBe(300);
    // claude-sonnet-5: $3/M in, $15/M out → 0.0036 + 0.0045
    expect(Number(body.run.costUsd)).toBeCloseTo(0.0081, 6);
    expect(body.summary.durationMs).not.toBeNull();
  });

  it("404s a run belonging to someone else", async () => {
    const runId = await startRun("mine");
    await execute(scripted([{ role: "assistant", content: "done" }]));

    const stranger = await signUp(ctx.app, "stranger@example.com");
    const res = await as(
      ctx.app,
      stranger,
    )(`/v1/workspaces/${stranger.workspaceId}/activity/runs/${runId}/activity`);
    expect(res.status).toBe(404);
  });
});

describe("usage", () => {
  it("totals spend and tokens, and breaks them down by agent", async () => {
    for (const text of ["one", "two"]) {
      await startRun(text);
      await execute(scripted([{ role: "assistant", content: "done" }]));
    }

    const usage = (await (await api(`/v1/workspaces/${ws}/activity/usage`)).json()) as {
      totals: { runs: number; succeeded: number; costUsd: string; inputTokens: number };
      byAgent: { agentName: string; runs: number; costUsd: string }[];
      daily: { day: string; runs: number }[];
    };

    expect(usage.totals.runs).toBe(2);
    expect(usage.totals.succeeded).toBe(2);
    expect(Number(usage.totals.costUsd)).toBeCloseTo(0.0162, 6);
    expect(Number(usage.totals.inputTokens)).toBe(2400);
    expect(usage.byAgent).toHaveLength(1);
    expect(usage.byAgent[0]).toMatchObject({ agentName: "Assistant", runs: 2 });
    expect(usage.daily.at(-1)?.runs).toBe(2);
  });
});

describe("runtime health", () => {
  it("is healthy when work is flowing", async () => {
    await startRun("hello");
    await execute(scripted([{ role: "assistant", content: "hi" }]));

    const { health } = (await (await api(`/v1/workspaces/${ws}/activity/health`)).json()) as {
      health: { state: string; lastHour: { runs: number; failed: number } };
    };
    expect(health.state).toBe("healthy");
    expect(health.lastHour.runs).toBe(1);
  });

  it("calls itself stalled when queued work is going unclaimed", async () => {
    const runId = await startRun("nobody will run this");
    // Backdate it past the threshold, as an unclaimed run would drift.
    await ctx.handle.db
      .update(runs)
      .set({ queuedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(runs.id, runId));

    const { health } = (await (await api(`/v1/workspaces/${ws}/activity/health`)).json()) as {
      health: { state: string; live: { stalled: number } };
    };
    expect(health.state).toBe("stalled");
    expect(health.live.stalled).toBe(1);
  });
});

describe("summarising a trace", () => {
  const run = { status: "succeeded", error: null, startedAt: null, finishedAt: null };

  it("counts each kind of step, and names the tools used", () => {
    expect(
      summarise(run, [
        { type: "model_call", data: {}, inputTokens: 10, outputTokens: 5 },
        {
          type: "tool_call",
          data: { tool: "filesystem", ok: true },
          inputTokens: 0,
          outputTokens: 0,
        },
        {
          type: "tool_call",
          data: { tool: "filesystem", ok: false },
          inputTokens: 0,
          outputTokens: 0,
        },
        { type: "tool_call", data: { tool: "http", ok: true }, inputTokens: 0, outputTokens: 0 },
        { type: "delegation", data: { to: "researcher" }, inputTokens: 0, outputTokens: 0 },
      ]),
    ).toMatchObject({
      modelCalls: 1,
      toolCalls: 3,
      failedToolCalls: 1,
      delegations: 1,
      // Each tool named once, however many times it was called.
      tools: ["filesystem", "http"],
    });
  });

  it("reports a duration only when the run actually ran", () => {
    expect(summarise(run, []).durationMs).toBeNull();
    expect(
      summarise(
        {
          ...run,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          finishedAt: new Date("2026-01-01T00:00:12Z"),
        },
        [],
      ).durationMs,
    ).toBe(12_000);
  });
});
