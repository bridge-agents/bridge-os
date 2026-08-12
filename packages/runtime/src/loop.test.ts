import type {
  BridgeTool,
  CompletionRequest,
  CompletionResult,
  Provider,
  ToolResult,
} from "@bridge/sdk";
import { parseManifest, personalAssistantTemplate, softwareTeamTemplate } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compile, type RuntimePlan, requiredProviders } from "./compiler.js";
import { type LoopDeps, type RunStepRecord, runAgentLoop } from "./loop.js";

/** Captures the last request an adapter received. */
const seen: { request?: CompletionRequest } = {};

function scripted(replies: Partial<CompletionResult>[]): Provider {
  let index = 0;
  return {
    id: "scripted",
    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const reply = replies[Math.min(index++, replies.length - 1)] ?? {};
      seen.request = request;
      return {
        message: reply.message ?? { role: "assistant", content: "done" },
        usage: reply.usage ?? { inputTokens: 10, outputTokens: 5 },
        stopReason: reply.stopReason ?? "end",
        model: reply.model,
      };
    },
  };
}

/** A tool that records its calls, with configurable danger. */
function fakeTool(
  name: string,
  options: { dangerous?: boolean; result?: ToolResult; calls?: unknown[] } = {},
): BridgeTool {
  const tool: BridgeTool<{ value?: string }> = {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({ value: z.string().optional() }),
    actions: [{ name: "use", dangerous: options.dangerous }],
    actionFor: () => "use",
    async execute(input) {
      options.calls?.push(input);
      return options.result ?? { ok: true, output: `${name} ran` };
    },
  };
  return tool as BridgeTool;
}

function harness(
  provider: Provider,
  overrides: Partial<LoopDeps> = {},
): { steps: RunStepRecord[]; deps: LoopDeps } {
  const steps: RunStepRecord[] = [];
  return {
    steps,
    deps: {
      getProvider: async () => provider,
      toolsFor: () => [],
      onStep: async (step) => {
        steps.push(step);
      },
      isCancelled: async () => false,
      context: { workspaceId: "ws_1", agentId: "agt_1", runId: "run_1" },
      ...overrides,
    },
  };
}

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
  message: {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: `c_${name}`, name, arguments: args }],
  },
  stopReason: "tool_use" as const,
});

const plan = compile(parseManifest(personalAssistantTemplate.manifest));
const teamPlan = compile(parseManifest(softwareTeamTemplate.manifest));

/** Plan whose single agent may use one tool under a given policy. */
function planWithTool(tool: BridgeTool, policy: RuntimePlan["permissions"]): RuntimePlan {
  return {
    entryAgent: "main",
    agents: {
      main: {
        name: "main",
        instructions: "Do the thing.",
        model: { provider: "test", model: "test-1" },
        tools: [{ name: tool.name, kind: "native", config: {} }],
        canDelegateTo: [],
      },
    },
    tools: [{ name: tool.name, kind: "native", config: {} }],
    permissions: policy,
    limits: { maxConcurrentRuns: 1, maxRunSeconds: 900 },
    sandbox: { network: "restricted", filesystem: "workspace" },
    deployment: { target: "local", background: false },
  };
}

describe("compiler", () => {
  it("resolves model roles to concrete refs", () => {
    expect(plan.agents.assistant?.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(plan.agents.researcher?.model.model).toBe("claude-haiku-4-5");
  });

  it("lists every provider the plan needs", () => {
    expect(requiredProviders(teamPlan).sort()).toEqual(["anthropic", "openai"]);
  });

  it("carries tools, limits, sandbox and deployment through", () => {
    expect(plan.tools.map((tool) => tool.name)).toEqual(["web-search"]);
    expect(plan.limits.maxRunSeconds).toBeGreaterThan(0);
    expect(plan.sandbox.filesystem).toBe("workspace");
    expect(plan.deployment.target).toBe("local");
  });

  it("rejects a manifest whose agent points at a missing model role", () => {
    const broken = structuredClone(personalAssistantTemplate.manifest);
    delete (broken.models.roles as Record<string, unknown>).fast;
    expect(() => compile(broken)).toThrow(/unknown model role/);
  });
});

describe("basic loop", () => {
  it("returns the model's answer", async () => {
    const { deps, steps } = harness(
      scripted([{ message: { role: "assistant", content: "Here you go." } }]),
    );
    const result = await runAgentLoop({
      plan,
      messages: [{ role: "user", content: "hi" }],
      deps,
    });

    expect(result.status).toBe("succeeded");
    expect(result.content).toBe("Here you go.");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(steps).toHaveLength(1);
  });

  it("puts the agent's instructions in the system turn", async () => {
    const { deps } = harness(scripted([{}]));
    await runAgentLoop({ plan, messages: [], deps });

    expect(seen.request?.messages[0]?.role).toBe("system");
    expect(seen.request?.messages[0]?.content).toContain("personal assistant");
  });

  it("honours cancellation and the deadline", async () => {
    const cancelled = harness(scripted([{}]), { isCancelled: async () => true });
    expect((await runAgentLoop({ plan, messages: [], deps: cancelled.deps })).status).toBe(
      "cancelled",
    );

    const expired = harness(scripted([{}]), { deadlineAt: Date.now() - 1 });
    expect((await runAgentLoop({ plan, messages: [], deps: expired.deps })).status).toBe(
      "limit_reached",
    );
  });

  it("stops cleanly on a refusal", async () => {
    const { deps } = harness(
      scripted([{ message: { role: "assistant", content: "" }, stopReason: "refusal" }]),
    );
    expect((await runAgentLoop({ plan, messages: [], deps })).status).toBe("refused");
  });

  it("bounds runaway tool loops", async () => {
    const tool = fakeTool("looper");
    const { deps } = harness(scripted([toolCall("looper")]), {
      toolsFor: () => [tool],
      maxIterations: 3,
    });

    const result = await runAgentLoop({
      plan: planWithTool(tool, { default: "allow", rules: [] }),
      messages: [],
      deps,
    });
    expect(result.status).toBe("limit_reached");
  });
});

describe("tool execution", () => {
  it("executes an allowed tool and feeds the result back", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("reader", { calls });
    const { deps, steps } = harness(
      scripted([
        toolCall("reader", { value: "x" }),
        { message: { role: "assistant", content: "ok" } },
      ]),
      { toolsFor: () => [tool] },
    );

    const result = await runAgentLoop({
      plan: planWithTool(tool, {
        default: "ask",
        rules: [{ resource: "tool:reader", actions: "*", effect: "allow" }],
      }),
      messages: [],
      deps,
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([{ value: "x" }]);
    const step = steps.find((entry) => entry.type === "tool_call");
    expect(step?.data).toMatchObject({ tool: "reader", executed: true, ok: true });
    // The model saw the result as a tool message.
    expect(seen.request?.messages.at(-1)).toMatchObject({ role: "tool", content: "reader ran" });
  });

  it("advertises granted tools to the model", async () => {
    const tool = fakeTool("reader");
    const { deps } = harness(scripted([{}]), { toolsFor: () => [tool] });
    await runAgentLoop({
      plan: planWithTool(tool, { default: "allow", rules: [] }),
      messages: [],
      deps,
    });

    expect(seen.request?.tools?.map((definition) => definition.name)).toContain("reader");
  });

  it("refuses a denied tool without executing it", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("writer", { calls });
    const { deps, steps } = harness(
      scripted([toolCall("writer"), { message: { role: "assistant", content: "fine" } }]),
      { toolsFor: () => [tool] },
    );

    await runAgentLoop({
      plan: planWithTool(tool, {
        default: "allow",
        rules: [{ resource: "tool:writer", actions: "*", effect: "deny" }],
      }),
      messages: [],
      deps,
    });

    expect(calls).toEqual([]);
    expect(steps.find((entry) => entry.type === "tool_call")?.data).toMatchObject({
      effect: "deny",
      executed: false,
    });
  });

  it("reports an unknown tool instead of hanging", async () => {
    const tool = fakeTool("known");
    const { deps } = harness(
      scripted([toolCall("mystery"), { message: { role: "assistant", content: "moving on" } }]),
      { toolsFor: () => [tool] },
    );

    const result = await runAgentLoop({
      plan: planWithTool(tool, { default: "allow", rules: [] }),
      messages: [],
      deps,
    });
    expect(result.status).toBe("succeeded");
  });

  it("rejects input that does not match the tool's schema", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("strict", { calls });
    const { deps, steps } = harness(
      scripted([
        toolCall("strict", { value: 42 }),
        { message: { role: "assistant", content: "ok" } },
      ]),
      { toolsFor: () => [tool] },
    );

    await runAgentLoop({
      plan: planWithTool(tool, { default: "allow", rules: [] }),
      messages: [],
      deps,
    });

    expect(calls).toEqual([]);
    expect(steps.find((entry) => entry.type === "tool_call")?.data).toMatchObject({ ok: false });
  });
});

describe("dangerous actions", () => {
  it("asks before a destructive action a permissive default would have allowed", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("deleter", { dangerous: true, calls });
    const { deps } = harness(scripted([toolCall("deleter")]), { toolsFor: () => [tool] });

    const result = await runAgentLoop({
      // "allow everything" must not silently cover a destructive action.
      plan: planWithTool(tool, { default: "allow", rules: [] }),
      messages: [],
      deps,
    });

    expect(result.status).toBe("waiting_approval");
    expect(calls).toEqual([]);
    if (result.status === "waiting_approval") {
      expect(result.request).toMatchObject({ toolName: "deleter", action: "use" });
    }
  });

  it("runs a destructive action when a rule allows it explicitly", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("deleter", { dangerous: true, calls });
    const { deps } = harness(
      scripted([toolCall("deleter"), { message: { role: "assistant", content: "deleted" } }]),
      { toolsFor: () => [tool] },
    );

    const result = await runAgentLoop({
      plan: planWithTool(tool, {
        default: "ask",
        rules: [{ resource: "tool:deleter", actions: "*", effect: "allow" }],
      }),
      messages: [],
      deps,
    });

    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
  });
});

describe("approval pause and resume", () => {
  const askPolicy = { default: "ask" as const, rules: [] };

  it("suspends with a checkpoint, then executes the tool once approved", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("sender", { dangerous: true, calls });
    const toolPlan = planWithTool(tool, askPolicy);

    const first = harness(scripted([toolCall("sender", { value: "email" })]), {
      toolsFor: () => [tool],
    });
    const paused = await runAgentLoop({ plan: toolPlan, messages: [], deps: first.deps });
    expect(paused.status).toBe("waiting_approval");
    if (paused.status !== "waiting_approval") return;

    // The checkpoint is plain data — it survives a database round trip.
    const roundTripped = JSON.parse(JSON.stringify(paused.checkpoint));

    const second = harness(scripted([{ message: { role: "assistant", content: "sent" } }]), {
      toolsFor: () => [tool],
    });
    const resumed = await runAgentLoop({
      plan: toolPlan,
      deps: second.deps,
      resume: { checkpoint: roundTripped, decision: { approved: true } },
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.content).toBe("sent");
    expect(calls).toEqual([{ value: "email" }]);
    expect(second.steps.find((step) => step.type === "tool_call")?.data).toMatchObject({
      executed: true,
    });
  });

  it("tells the model why, and does not execute, when denied", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("sender", { dangerous: true, calls });
    const toolPlan = planWithTool(tool, askPolicy);

    const first = harness(scripted([toolCall("sender")]), { toolsFor: () => [tool] });
    const paused = await runAgentLoop({ plan: toolPlan, messages: [], deps: first.deps });
    if (paused.status !== "waiting_approval") throw new Error("expected a pause");

    const second = harness(scripted([{ message: { role: "assistant", content: "understood" } }]), {
      toolsFor: () => [tool],
    });
    const resumed = await runAgentLoop({
      plan: toolPlan,
      deps: second.deps,
      resume: {
        checkpoint: paused.checkpoint,
        decision: { approved: false, reason: "not while I am asleep" },
      },
    });

    expect(resumed.status).toBe("succeeded");
    expect(calls).toEqual([]);
    const denial = seen.request?.messages.find((message) => message.role === "tool");
    expect(denial?.content).toContain("not while I am asleep");
  });

  it("carries token usage across the pause", async () => {
    const tool = fakeTool("sender", { dangerous: true });
    const toolPlan = planWithTool(tool, askPolicy);

    const first = harness(scripted([toolCall("sender")]), { toolsFor: () => [tool] });
    const paused = await runAgentLoop({ plan: toolPlan, messages: [], deps: first.deps });
    if (paused.status !== "waiting_approval") throw new Error("expected a pause");
    expect(paused.usage.inputTokens).toBe(10);

    const second = harness(scripted([{ message: { role: "assistant", content: "done" } }]), {
      toolsFor: () => [tool],
    });
    const resumed = await runAgentLoop({
      plan: toolPlan,
      deps: second.deps,
      resume: { checkpoint: paused.checkpoint, decision: { approved: true } },
    });

    // 10 from before the pause plus 10 after — the run's total, not a reset.
    expect(resumed.usage.inputTokens).toBe(20);
  });
});

describe("delegation", () => {
  it("delegates and feeds the subagent's answer back", async () => {
    const { deps, steps } = harness(
      scripted([
        toolCall("delegate_to_researcher", { task: "research bridges" }),
        { message: { role: "assistant", content: "Bridges are structures." } },
        { message: { role: "assistant", content: "Summary: bridges are structures." } },
      ]),
    );

    const result = await runAgentLoop({
      plan,
      messages: [{ role: "user", content: "tell me about bridges" }],
      deps,
    });

    expect(result.content).toBe("Summary: bridges are structures.");
    expect(steps.find((step) => step.type === "delegation")?.data).toMatchObject({
      to: "researcher",
      result: "Bridges are structures.",
    });
    expect(result.usage.inputTokens).toBe(30);
  });

  it("offers exactly the delegation targets the manifest allows", async () => {
    const { deps } = harness(scripted([{}]));
    await runAgentLoop({ plan, messages: [], deps });

    // The assistant may delegate to the researcher and to nobody else.
    expect(seen.request?.tools?.map((definition) => definition.name)).toEqual([
      "delegate_to_researcher",
    ]);
  });

  it("pauses for approval raised inside a subagent, and resumes it", async () => {
    const calls: unknown[] = [];
    const tool = fakeTool("shell", { dangerous: true, calls });

    // Entry agent delegates; the subagent then asks for a dangerous tool.
    const nested: RuntimePlan = {
      entryAgent: "lead",
      agents: {
        lead: {
          name: "lead",
          instructions: "Delegate the work.",
          model: { provider: "test", model: "t" },
          tools: [],
          canDelegateTo: ["worker"],
        },
        worker: {
          name: "worker",
          instructions: "Do the work.",
          model: { provider: "test", model: "t" },
          tools: [{ name: "shell", kind: "native", config: {} }],
          canDelegateTo: [],
        },
      },
      tools: [{ name: "shell", kind: "native", config: {} }],
      permissions: { default: "ask", rules: [] },
      limits: { maxConcurrentRuns: 1, maxRunSeconds: 900 },
      sandbox: { network: "restricted", filesystem: "workspace" },
      deployment: { target: "local", background: false },
    };

    const first = harness(
      scripted([
        toolCall("delegate_to_worker", { task: "clean up" }),
        toolCall("shell", { value: "rm" }),
      ]),
      { toolsFor: () => [tool] },
    );
    const paused = await runAgentLoop({ plan: nested, messages: [], deps: first.deps });

    expect(paused.status).toBe("waiting_approval");
    if (paused.status !== "waiting_approval") return;
    // The request names the subagent, and both frames are preserved.
    expect(paused.request.agentName).toBe("worker");
    expect(paused.checkpoint.frames).toHaveLength(2);

    const second = harness(
      scripted([
        { message: { role: "assistant", content: "cleaned" } },
        { message: { role: "assistant", content: "All done." } },
      ]),
      { toolsFor: () => [tool] },
    );
    const resumed = await runAgentLoop({
      plan: nested,
      deps: second.deps,
      resume: {
        checkpoint: JSON.parse(JSON.stringify(paused.checkpoint)),
        decision: { approved: true },
      },
    });

    // The subagent finished and the parent carried on to its own answer.
    expect(resumed.status).toBe("succeeded");
    expect(resumed.content).toBe("All done.");
    expect(calls).toEqual([{ value: "rm" }]);
    expect(second.steps.find((step) => step.type === "delegation")).toBeDefined();
  });
});
