import { createLogger } from "@bridge/core";
import { approvals, runSteps, runs } from "@bridge/db";
import { RunExecutor } from "@bridge/runtime";
import type { CompletionResult, Provider } from "@bridge/sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

const silentLogger = createLogger("test");
silentLogger.level = "silent";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let ws: string;
let agentId: string;

/**
 * An agent with a genuinely destructive capability: writing files. The
 * permission policy allows reads outright and leaves everything else to the
 * default, so a write has to be approved.
 */
let slugCounter = 0;

const manifest = (permissions: unknown) => ({
  specVersion: 1,
  meta: { name: "Filer", slug: `filer-${slugCounter++}` },
  models: { default: { provider: "openai-compatible", model: "local" } },
  agents: [{ name: "main", instructions: "Manage files.", tools: ["filesystem"] }],
  entryAgent: "main",
  tools: [{ name: "filesystem", kind: "native" }],
  permissions,
  runtime: { sandbox: { filesystem: "workspace", network: "none" } },
});

/** Model that asks to write a file, then reports what happened. */
function scriptedProvider(replies: Partial<CompletionResult>[]): Provider {
  let index = 0;
  return {
    id: "openai-compatible",
    async complete(): Promise<CompletionResult> {
      const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
      return {
        message: reply.message ?? { role: "assistant", content: "done" },
        usage: reply.usage ?? { inputTokens: 5, outputTokens: 5 },
        stopReason: reply.stopReason ?? "end",
        model: "local",
      };
    },
  };
}

const writeRequest = {
  message: {
    role: "assistant" as const,
    content: "",
    toolCalls: [
      {
        id: "call_1",
        name: "filesystem",
        arguments: { operation: "write", path: "report.txt", content: "hello" },
      },
    ],
  },
  stopReason: "tool_use" as const,
};

function executor(provider: Provider, dataDir: string) {
  return new RunExecutor({
    db: ctx.handle.db,
    logger: silentLogger,
    getProvider: async () => provider,
    dataDir,
  });
}

async function createAgent(permissions: unknown) {
  const res = await api(`/v1/workspaces/${ws}/agents`, {
    method: "POST",
    body: JSON.stringify({ manifest: manifest(permissions) }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${await res.text()}`);
  return ((await res.json()) as { agent: { id: string } }).agent.id;
}

async function startRun() {
  const res = await api(`/v1/workspaces/${ws}/agents/${agentId}/runs`, {
    method: "POST",
    body: JSON.stringify({ input: "write a report" }),
  });
  return ((await res.json()) as { run: { id: string } }).run.id;
}

const pendingApprovals = async () =>
  (
    (await (await api(`/v1/workspaces/${ws}/approvals`)).json()) as {
      approvals: { id: string; toolName: string; action: string; input: Record<string, unknown> }[];
    }
  ).approvals;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  ws = user.workspaceId;

  await api(`/v1/workspaces/${ws}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "openai-compatible", baseUrl: "http://localhost:9/v1" }),
  });
  agentId = await createAgent({ default: "ask", rules: [] });
});
afterEach(async () => {
  await ctx.close();
});

describe("approval lifecycle", () => {
  it("pauses the run, raises an approval, and resumes it once approved", async () => {
    const runId = await startRun();
    const provider = scriptedProvider([
      writeRequest,
      { message: { role: "assistant", content: "Report written." } },
    ]);
    const exec = executor(provider, `${ctx.dataDir}/a`);

    // First pass: the model asks to write, and the run parks.
    await exec.runOnce();

    const [paused] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(paused?.status).toBe("waiting_approval");
    expect(paused?.checkpoint).toBeTruthy();

    const pending = await pendingApprovals();
    expect(pending).toHaveLength(1);
    const request = pending[0];
    if (!request) throw new Error("expected a pending approval");
    expect(request).toMatchObject({ toolName: "filesystem", action: "write" });
    expect(request.input).toMatchObject({ path: "report.txt" });

    // A human approves.
    const approved = await api(`/v1/workspaces/${ws}/approvals/${request.id}/approve`, {
      method: "POST",
    });
    expect(approved.status).toBe(200);

    const [requeued] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(requeued?.status).toBe("queued");

    // Second pass: the executor resumes and the tool actually runs.
    await exec.runOnce();

    const [finished] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(finished?.status).toBe("succeeded");
    expect(finished?.checkpoint).toBeNull();
    expect(finished?.output).toMatchObject({ content: "Report written." });

    const steps = await ctx.handle.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    const toolStep = steps.find((step) => step.type === "tool_call");
    expect(toolStep?.data).toMatchObject({ tool: "filesystem", executed: true, ok: true });
    // Steps keep one ordered sequence across the pause.
    expect(steps.map((step) => step.seq).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("does not execute the tool when denied, and tells the model why", async () => {
    const runId = await startRun();
    const provider = scriptedProvider([
      writeRequest,
      { message: { role: "assistant", content: "Understood, I will not write it." } },
    ]);
    const exec = executor(provider, `${ctx.dataDir}/b`);

    await exec.runOnce();
    const pending = await pendingApprovals();

    const denied = await api(`/v1/workspaces/${ws}/approvals/${pending[0]?.id}/deny`, {
      method: "POST",
      body: JSON.stringify({ reason: "that path is protected" }),
    });
    expect(denied.status).toBe(200);

    await exec.runOnce();

    const [finished] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(finished?.status).toBe("succeeded");

    const steps = await ctx.handle.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    const toolStep = steps.find((step) => step.type === "tool_call");
    expect(toolStep?.data).toMatchObject({ executed: false, approved: false });
    expect(toolStep?.data).toMatchObject({ reason: "that path is protected" });
  });

  it("records the decision and stops showing it as pending", async () => {
    await startRun();
    const exec = executor(scriptedProvider([writeRequest]), `${ctx.dataDir}/c`);
    await exec.runOnce();

    const [pending] = await pendingApprovals();
    await api(`/v1/workspaces/${ws}/approvals/${pending?.id}/approve`, { method: "POST" });

    expect(await pendingApprovals()).toHaveLength(0);
    const [row] = await ctx.handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, pending?.id ?? ""));
    expect(row?.status).toBe("approved");
    expect(row?.decidedBy).toBe(user.userId);
    expect(row?.decidedAt).toBeTruthy();
  });

  it("refuses to decide the same approval twice", async () => {
    await startRun();
    await executor(scriptedProvider([writeRequest]), `${ctx.dataDir}/d`).runOnce();
    const [pending] = await pendingApprovals();

    expect(
      (await api(`/v1/workspaces/${ws}/approvals/${pending?.id}/approve`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (await api(`/v1/workspaces/${ws}/approvals/${pending?.id}/approve`, { method: "POST" }))
        .status,
    ).toBe(404);
  });

  it("never asks when a rule allows the action explicitly", async () => {
    agentId = await createAgent({
      default: "ask",
      rules: [{ resource: "tool:filesystem", actions: "*", effect: "allow" }],
    });
    const runId = await startRun();

    await executor(
      scriptedProvider([writeRequest, { message: { role: "assistant", content: "Written." } }]),
      `${ctx.dataDir}/e`,
    ).runOnce();

    const [finished] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(finished?.status).toBe("succeeded");
    expect(await pendingApprovals()).toHaveLength(0);
  });

  it("read access does not grant write access", async () => {
    // Reads are explicitly allowed; writing is not mentioned at all.
    agentId = await createAgent({
      default: "deny",
      rules: [{ resource: "tool:filesystem", actions: ["read", "list"], effect: "allow" }],
    });
    const runId = await startRun();

    await executor(
      scriptedProvider([writeRequest, { message: { role: "assistant", content: "Cannot." } }]),
      `${ctx.dataDir}/f`,
    ).runOnce();

    const [finished] = await ctx.handle.db.select().from(runs).where(eq(runs.id, runId));
    expect(finished?.status).toBe("succeeded");

    const steps = await ctx.handle.db.select().from(runSteps).where(eq(runSteps.runId, runId));
    expect(steps.find((step) => step.type === "tool_call")?.data).toMatchObject({
      effect: "deny",
      executed: false,
    });
    // Denied outright, so no human was ever asked.
    expect(await pendingApprovals()).toHaveLength(0);
  });
});

describe("approval isolation", () => {
  it("hides approvals from other tenants and refuses their decisions", async () => {
    await startRun();
    await executor(scriptedProvider([writeRequest]), `${ctx.dataDir}/g`).runOnce();
    const [pending] = await pendingApprovals();

    const mallory = as(ctx.app, await signUp(ctx.app, "mallory@example.com"));
    expect((await mallory(`/v1/workspaces/${ws}/approvals`)).status).toBe(404);
    expect(
      (await mallory(`/v1/workspaces/${ws}/approvals/${pending?.id}/approve`, { method: "POST" }))
        .status,
    ).toBe(404);

    const [untouched] = await ctx.handle.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, pending?.id ?? ""));
    expect(untouched?.status).toBe("pending");
  });
});
