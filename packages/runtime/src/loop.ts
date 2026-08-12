import { BridgeError } from "@bridge/core";
import type { ChatMessage, Provider, ProviderToolDefinition, TokenUsage } from "@bridge/sdk";
import { evaluatePermission } from "@bridge/spec";
import type { AgentPlan, RuntimePlan } from "./compiler.js";

/**
 * The agent loop: call the model, dispatch whatever it asks for, feed results
 * back, repeat until it answers or a limit stops it.
 *
 * Subagents are exposed to the model as ordinary tools (`delegate_to_<name>`),
 * so delegation reuses the tool-call machinery rather than adding a parallel
 * one — and Phase 4's real tools plug into the same dispatch point.
 */
export type RunStepRecord =
  | {
      type: "model_call";
      agentName: string;
      data: { model: string; provider: string; stopReason: string; content: string };
      usage: TokenUsage;
    }
  | { type: "tool_call"; agentName: string; data: Record<string, unknown> }
  | { type: "delegation"; agentName: string; data: { to: string; task: string; result: string } }
  | { type: "error"; agentName: string; data: { message: string } };

export interface LoopDeps {
  /** Resolves an adapter for a provider id; credentials are injected by the caller. */
  getProvider(providerId: string): Promise<Provider>;
  /** Persist a step as it happens, so a crash leaves a partial trace, not nothing. */
  onStep(step: RunStepRecord): Promise<void>;
  /** Checked between steps; true ends the run as cancelled. */
  isCancelled(): Promise<boolean>;
  /** Wall-clock deadline in epoch ms, derived from runtime.limits.maxRunSeconds. */
  deadlineAt?: number;
  now?: () => number;
  /** Guards against a model that keeps calling tools forever. */
  maxIterations?: number;
  /** Guards against delegation cycles between agents. */
  maxDepth?: number;
}

export interface LoopResult {
  content: string;
  messages: ChatMessage[];
  usage: TokenUsage;
  status: "succeeded" | "cancelled" | "refused" | "limit_reached";
}

const DELEGATE_PREFIX = "delegate_to_";

function delegationTools(agent: AgentPlan, plan: RuntimePlan): ProviderToolDefinition[] {
  return agent.canDelegateTo.flatMap((name) => {
    const target = plan.agents[name];
    if (!target) return [];
    return [
      {
        name: `${DELEGATE_PREFIX}${name}`,
        description: `Delegate a self-contained task to the "${name}" agent. ${target.instructions.slice(
          0,
          200,
        )}`,
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "Everything the agent needs to do the work. It cannot see this conversation.",
            },
          },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ];
  });
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

/**
 * Run one agent to completion. Recurses for delegation, which is why depth is
 * bounded independently of iterations.
 */
export async function runAgentLoop(options: {
  plan: RuntimePlan;
  agentName: string;
  messages: ChatMessage[];
  deps: LoopDeps;
  depth?: number;
}): Promise<LoopResult> {
  const { plan, agentName, deps, depth = 0 } = options;
  const now = deps.now ?? Date.now;
  const maxIterations = deps.maxIterations ?? 12;
  const maxDepth = deps.maxDepth ?? 3;

  const agent = plan.agents[agentName];
  if (!agent) throw new BridgeError("internal", `unknown agent "${agentName}"`);

  const provider = await deps.getProvider(agent.model.provider);
  const tools = depth < maxDepth ? delegationTools(agent, plan) : [];

  const messages: ChatMessage[] = [
    { role: "system", content: agent.instructions },
    ...options.messages,
  ];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (await deps.isCancelled()) return { content: "", messages, usage, status: "cancelled" };
    if (deps.deadlineAt !== undefined && now() > deps.deadlineAt) {
      return { content: "", messages, usage, status: "limit_reached" };
    }

    const result = await provider.complete({
      model: agent.model.model,
      messages,
      ...(tools.length ? { tools } : {}),
    });
    usage = addUsage(usage, result.usage);

    await deps.onStep({
      type: "model_call",
      agentName,
      data: {
        model: result.model ?? agent.model.model,
        provider: agent.model.provider,
        stopReason: result.stopReason,
        content: result.message.content,
      },
      usage: result.usage,
    });

    messages.push(result.message);

    // A refusal is a successful response with no usable content — stop cleanly.
    if (result.stopReason === "refusal") {
      return { content: result.message.content, messages, usage, status: "refused" };
    }

    const toolCalls = result.message.toolCalls ?? [];
    if (result.stopReason !== "tool_use" || toolCalls.length === 0) {
      return { content: result.message.content, messages, usage, status: "succeeded" };
    }

    for (const call of toolCalls) {
      if (call.name.startsWith(DELEGATE_PREFIX)) {
        const target = call.name.slice(DELEGATE_PREFIX.length);
        const task = String(call.arguments.task ?? "");

        // Subagents start with a clean context: only the task they were given.
        const sub = await runAgentLoop({
          plan,
          agentName: target,
          messages: [{ role: "user", content: task }],
          deps,
          depth: depth + 1,
        });
        usage = addUsage(usage, sub.usage);

        await deps.onStep({
          type: "delegation",
          agentName,
          data: { to: target, task, result: sub.content },
        });
        messages.push({ role: "tool", content: sub.content, toolCallId: call.id });
        continue;
      }

      // Phase 4 registers real tools here. Until then the permission engine is
      // still consulted, so the decision path is exercised from day one.
      const effect = evaluatePermission(plan.permissions, `tool:${call.name}`, "execute");
      const message =
        effect === "deny"
          ? `Tool "${call.name}" is denied by this agent's permissions.`
          : `Tool "${call.name}" is not available in this Bridge build yet. Continue without it.`;

      await deps.onStep({
        type: "tool_call",
        agentName,
        data: { tool: call.name, arguments: call.arguments, effect, executed: false },
      });
      messages.push({ role: "tool", content: message, toolCallId: call.id });
    }
  }

  await deps.onStep({
    type: "error",
    agentName,
    data: { message: `stopped after ${maxIterations} iterations without a final answer` },
  });
  return { content: "", messages, usage, status: "limit_reached" };
}
