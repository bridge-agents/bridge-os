import type { CompletionRequest, CompletionResult, Provider } from "@bridge/sdk";
import { parseManifest, personalAssistantTemplate, softwareTeamTemplate } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { compile, requiredProviders } from "./compiler.js";
import { type RunStepRecord, runAgentLoop } from "./loop.js";

/** Captures the last request an adapter received. */
const seen: { request?: CompletionRequest } = {};

/** Provider that replays a scripted sequence of completions. */
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

function deps(
  provider: Provider,
  overrides: Partial<Parameters<typeof runAgentLoop>[0]["deps"]> = {},
) {
  const steps: RunStepRecord[] = [];
  return {
    steps,
    deps: {
      getProvider: async () => provider,
      onStep: async (step: RunStepRecord) => {
        steps.push(step);
      },
      isCancelled: async () => false,
      ...overrides,
    },
  };
}

const plan = compile(parseManifest(personalAssistantTemplate.manifest));
const teamPlan = compile(parseManifest(softwareTeamTemplate.manifest));

describe("compiler", () => {
  it("resolves model roles to concrete refs", () => {
    expect(plan.agents.assistant?.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    // The researcher uses the "fast" role.
    expect(plan.agents.researcher?.model.model).toBe("claude-haiku-4-5");
  });

  it("lists every provider the plan needs", () => {
    expect(requiredProviders(teamPlan).sort()).toEqual(["anthropic", "openai"]);
  });

  it("carries limits and deployment through", () => {
    expect(plan.limits.maxRunSeconds).toBeGreaterThan(0);
    expect(plan.deployment.target).toBe("local");
  });

  it("rejects a manifest whose agent points at a missing model role", () => {
    const broken = structuredClone(personalAssistantTemplate.manifest);
    // Bypass schema validation to prove the compiler is a second line of defence.
    (broken.models.roles as Record<string, unknown>).fast = undefined;
    delete (broken.models.roles as Record<string, unknown>).fast;
    expect(() => compile(broken)).toThrow(/unknown model role/);
  });
});

describe("runAgentLoop", () => {
  it("returns the model's answer", async () => {
    const { deps: d, steps } = deps(
      scripted([{ message: { role: "assistant", content: "Here you go." } }]),
    );
    const result = await runAgentLoop({
      plan,
      agentName: "assistant",
      messages: [{ role: "user", content: "hi" }],
      deps: d,
    });

    expect(result.status).toBe("succeeded");
    expect(result.content).toBe("Here you go.");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.type).toBe("model_call");
  });

  it("puts the agent's instructions in the system turn", async () => {
    const { deps: d } = deps(scripted([{}]));
    await runAgentLoop({ plan, agentName: "assistant", messages: [], deps: d });

    const request = seen.request as CompletionRequest;
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("personal assistant");
  });

  it("delegates to a subagent and feeds the result back", async () => {
    const provider = scripted([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "delegate_to_researcher", arguments: { task: "research bridges" } },
          ],
        },
        stopReason: "tool_use",
      },
      { message: { role: "assistant", content: "Bridges are structures." } },
      { message: { role: "assistant", content: "Summary: bridges are structures." } },
    ]);
    const { deps: d, steps } = deps(provider);

    const result = await runAgentLoop({
      plan,
      agentName: "assistant",
      messages: [{ role: "user", content: "tell me about bridges" }],
      deps: d,
    });

    expect(result.content).toBe("Summary: bridges are structures.");
    const delegation = steps.find((s) => s.type === "delegation");
    expect(delegation).toBeDefined();
    expect(delegation?.data).toMatchObject({ to: "researcher", result: "Bridges are structures." });
    // Usage covers the subagent's tokens too.
    expect(result.usage.inputTokens).toBe(30);
  });

  it("only advertises delegation to agents the manifest allows", async () => {
    const { deps: d } = deps(scripted([{}]));
    await runAgentLoop({ plan, agentName: "researcher", messages: [], deps: d });

    const request = seen.request as CompletionRequest;
    expect(request.tools ?? []).toHaveLength(0); // researcher delegates to nobody
  });

  it("stops cleanly on a refusal instead of looping", async () => {
    const { deps: d } = deps(
      scripted([{ message: { role: "assistant", content: "" }, stopReason: "refusal" }]),
    );
    const result = await runAgentLoop({ plan, agentName: "assistant", messages: [], deps: d });
    expect(result.status).toBe("refused");
  });

  it("honours cancellation between steps", async () => {
    const { deps: d } = deps(scripted([{}]), { isCancelled: async () => true });
    const result = await runAgentLoop({ plan, agentName: "assistant", messages: [], deps: d });
    expect(result.status).toBe("cancelled");
  });

  it("stops at the deadline", async () => {
    const { deps: d } = deps(scripted([{}]), { deadlineAt: Date.now() - 1 });
    const result = await runAgentLoop({ plan, agentName: "assistant", messages: [], deps: d });
    expect(result.status).toBe("limit_reached");
  });

  it("bounds runaway tool loops", async () => {
    const provider = scripted([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", name: "web-search", arguments: {} }],
        },
        stopReason: "tool_use",
      },
    ]);
    const { deps: d } = deps(provider);

    const result = await runAgentLoop({
      plan,
      agentName: "assistant",
      messages: [],
      deps: { ...d, maxIterations: 3 },
    });

    expect(result.status).toBe("limit_reached");
  });

  it("consults the permission policy for non-delegation tools", async () => {
    const denyPlan = structuredClone(plan);
    denyPlan.permissions = {
      default: "deny",
      rules: [{ resource: "tool:web-search", actions: "*", effect: "deny" }],
    };
    const provider = scripted([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c", name: "web-search", arguments: {} }],
        },
        stopReason: "tool_use",
      },
      { message: { role: "assistant", content: "ok, without it" } },
    ]);
    const { deps: d, steps } = deps(provider);

    await runAgentLoop({ plan: denyPlan, agentName: "assistant", messages: [], deps: d });

    const toolStep = steps.find((s) => s.type === "tool_call");
    expect(toolStep?.data).toMatchObject({ tool: "web-search", effect: "deny", executed: false });
  });
});
