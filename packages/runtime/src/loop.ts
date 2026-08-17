import { BridgeError } from "@bridge/core";
import type {
  BridgeTool,
  ChatMessage,
  Provider,
  ProviderToolDefinition,
  TokenUsage,
  ToolArtifact,
  ToolCall,
} from "@bridge/sdk";
import { decideToolPermission, type PermissionEffect } from "@bridge/spec";
import { z } from "zod";
import type { AgentPlan, RuntimePlan } from "./compiler.js";

/**
 * The agent loop: call the model, dispatch what it asks for, feed results
 * back, repeat until it answers or a limit stops it.
 *
 * It is an explicit stack of frames rather than recursion, because a run can
 * pause **anywhere** — including inside a subagent — waiting for a human to
 * approve a tool call. A stack serializes; a call stack does not. Suspending
 * writes the frames to the run's checkpoint and returns; resuming rebuilds
 * them and continues from the exact tool call that was waiting.
 *
 * Subagents are exposed to the model as `delegate_to_<name>` tools, so
 * delegation and tool use share one dispatch path.
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

/** One agent's in-progress turn. Serialized verbatim into a run checkpoint. */
export interface LoopFrame {
  agentName: string;
  messages: ChatMessage[];
  /** Tool calls from the last assistant turn not yet handled, in order. */
  pending: ToolCall[];
  /** When this frame is a subagent, the parent tool call its answer satisfies. */
  returnToolCallId?: string;
}

export interface LoopCheckpoint {
  frames: LoopFrame[];
  usage: TokenUsage;
  /** Model calls already spent, so a resumed run keeps its original budget. */
  iterations: number;
}

export interface ApprovalRequest {
  agentName: string;
  toolName: string;
  action: string;
  input: Record<string, unknown>;
  toolCallId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface LoopDeps {
  getProvider(providerId: string): Promise<Provider>;
  /** Executable tools for one agent, already bound to its sandbox. */
  toolsFor(agentName: string): BridgeTool[] | Promise<BridgeTool[]>;
  onStep(step: RunStepRecord): Promise<void>;
  /**
   * Called with assistant text as it is generated. Providing it switches the
   * loop to `streamComplete`, which streams *and* returns the full message —
   * so a turn that ends in a tool call still works.
   */
  onDelta?(delta: { agentName: string; text: string }): void;
  onArtifacts?(artifacts: ToolArtifact[]): void;
  isCancelled(): Promise<boolean>;
  /** Checked at each model boundary so daily budgets stop an in-progress tool loop. */
  isBudgetExceeded?(usage: TokenUsage): Promise<boolean>;
  context: { workspaceId: string; agentId: string; runId: string };
  log?: (message: string, data?: Record<string, unknown>) => void;
  deadlineAt?: number;
  now?: () => number;
  maxIterations?: number;
  maxDepth?: number;
}

export type LoopResult =
  | {
      status: "succeeded" | "cancelled" | "refused" | "limit_reached";
      content: string;
      usage: TokenUsage;
    }
  | {
      status: "waiting_approval";
      content: "";
      usage: TokenUsage;
      checkpoint: LoopCheckpoint;
      request: ApprovalRequest;
    };

const DELEGATE_PREFIX = "delegate_to_";

function toolDefinition(tool: BridgeTool): ProviderToolDefinition {
  let schema = tool.jsonSchema;
  if (!schema) {
    try {
      schema = z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<string, unknown>;
    } catch {
      schema = { type: "object", properties: {} };
    }
  }
  return { name: tool.name, description: tool.description, inputSchema: schema };
}

function delegationDefinitions(agent: AgentPlan, plan: RuntimePlan): ProviderToolDefinition[] {
  return agent.canDelegateTo.flatMap((name) => {
    const target = plan.agents[name];
    if (!target) return [];
    return [
      {
        name: `${DELEGATE_PREFIX}${name}`,
        description: `Delegate a self-contained task to the "${name}" agent. ${target.instructions.slice(0, 200)}`,
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

/** What the model is told when a tool cannot run. Denials say why. */
function refusalMessage(toolName: string, effect: PermissionEffect, reason?: string): string {
  return effect === "deny"
    ? `Tool "${toolName}" is denied by this agent's permissions.${reason ? ` ${reason}` : ""} Do not retry it; continue without it or explain what you need.`
    : `Tool "${toolName}" was not approved.${reason ? ` Reason: ${reason}` : ""} Continue without it.`;
}

export async function runAgentLoop(options: {
  plan: RuntimePlan;
  deps: LoopDeps;
  /** A fresh run starts from these messages. */
  messages?: ChatMessage[];
  /** A paused run resumes from its checkpoint with the human's decision. */
  resume?: { checkpoint: LoopCheckpoint; decision: ApprovalDecision };
}): Promise<LoopResult> {
  const { plan, deps } = options;
  const now = deps.now ?? Date.now;
  const maxIterations = deps.maxIterations ?? 12;
  const maxDepth = deps.maxDepth ?? 3;

  const toolCache = new Map<string, BridgeTool[]>();
  const toolsFor = async (agentName: string) => {
    const cached = toolCache.get(agentName);
    if (cached) return cached;
    const tools = await deps.toolsFor(agentName);
    toolCache.set(agentName, tools);
    return tools;
  };

  const agentFor = (name: string): AgentPlan => {
    const agent = plan.agents[name];
    if (!agent) throw new BridgeError("internal", `unknown agent "${name}"`);
    return agent;
  };

  let frames: LoopFrame[];
  let usage: TokenUsage;
  let iterations: number;

  if (options.resume) {
    ({ frames, usage, iterations } = {
      frames: options.resume.checkpoint.frames.map((frame) => ({ ...frame })),
      usage: options.resume.checkpoint.usage,
      iterations: options.resume.checkpoint.iterations,
    });
  } else {
    const entry = agentFor(plan.entryAgent);
    frames = [
      {
        agentName: entry.name,
        messages: [{ role: "system", content: entry.instructions }, ...(options.messages ?? [])],
        pending: [],
      },
    ];
    usage = { inputTokens: 0, outputTokens: 0 };
    iterations = 0;
  }

  /** Execute one already-authorized tool call and record it. */
  const execute = async (
    frame: LoopFrame,
    call: ToolCall,
    tool: BridgeTool,
    action: string,
  ): Promise<void> => {
    const started = now();
    const parsed = tool.inputSchema.safeParse(call.arguments);

    const result = parsed.success
      ? await tool.execute(parsed.data, {
          workspaceId: deps.context.workspaceId,
          agentId: deps.context.agentId,
          runId: deps.context.runId,
          log: (message, data) => deps.log?.(message, data),
          // Defence in depth: the loop already decided, but a tool that asks
          // must get the same answer.
          checkPermission: (checked) =>
            decideToolPermission(
              plan.permissions,
              tool.name,
              checked,
              tool.actions.find((entry) => entry.name === checked)?.dangerous ?? false,
            ),
        })
      : {
          ok: false,
          output: null,
          error: `invalid input: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
        };

    if (result.artifacts?.length) deps.onArtifacts?.(result.artifacts);

    await deps.onStep({
      type: "tool_call",
      agentName: frame.agentName,
      data: {
        tool: tool.name,
        action,
        arguments: call.arguments,
        effect: "allow",
        executed: true,
        ok: result.ok,
        durationMs: Math.round(now() - started),
        output: result.ok ? result.output : undefined,
        error: result.error,
      },
    });

    frame.messages.push({
      role: "tool",
      content:
        typeof result.output === "string"
          ? result.output || (result.error ?? "")
          : JSON.stringify(result.ok ? result.output : { error: result.error }),
      toolCallId: call.id,
    });
  };

  // A resumed run continues at the exact call that was waiting.
  if (options.resume) {
    const frame = frames.at(-1);
    const call = frame?.pending[0];
    if (frame && call) {
      frame.pending.shift();
      const { decision } = options.resume;
      const tools = await toolsFor(frame.agentName);
      const tool = tools.find((candidate) => candidate.name === call.name);

      if (!decision.approved || !tool) {
        await deps.onStep({
          type: "tool_call",
          agentName: frame.agentName,
          data: {
            tool: call.name,
            arguments: call.arguments,
            effect: "ask",
            executed: false,
            approved: false,
            reason: decision.reason,
          },
        });
        frame.messages.push({
          role: "tool",
          content: refusalMessage(call.name, "ask", decision.reason),
          toolCallId: call.id,
        });
      } else {
        const action = tool.actionFor?.(call.arguments) ?? tool.actions[0]?.name ?? "call";
        await execute(frame, call, tool, action);
      }
    }
  }

  while (frames.length > 0) {
    if (await deps.isCancelled()) return { status: "cancelled", content: "", usage };
    if (await deps.isBudgetExceeded?.(usage)) {
      return { status: "limit_reached", content: "", usage };
    }
    if (deps.deadlineAt !== undefined && now() > deps.deadlineAt) {
      return { status: "limit_reached", content: "", usage };
    }

    const frame = frames.at(-1);
    if (!frame) break;

    // 1. Drain tool calls the model already asked for.
    let delegated = false;
    while (frame.pending.length > 0) {
      const call = frame.pending[0];
      if (!call) break;

      if (call.name.startsWith(DELEGATE_PREFIX)) {
        frame.pending.shift();
        const targetName = call.name.slice(DELEGATE_PREFIX.length);
        const task = String(call.arguments.task ?? "");

        if (frames.length > maxDepth || !plan.agents[targetName]) {
          frame.messages.push({
            role: "tool",
            content: `Cannot delegate to "${targetName}" here. Do the work yourself.`,
            toolCallId: call.id,
          });
          continue;
        }

        // Subagents start clean: only the task they were handed.
        frames.push({
          agentName: targetName,
          messages: [
            { role: "system", content: agentFor(targetName).instructions },
            { role: "user", content: task },
          ],
          pending: [],
          returnToolCallId: call.id,
        });
        delegated = true;
        break;
      }

      const tools = await toolsFor(frame.agentName);
      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        frame.pending.shift();
        await deps.onStep({
          type: "tool_call",
          agentName: frame.agentName,
          data: { tool: call.name, executed: false, error: "unknown tool" },
        });
        frame.messages.push({
          role: "tool",
          content: `Tool "${call.name}" is not available to this agent.`,
          toolCallId: call.id,
        });
        continue;
      }

      const action = tool.actionFor?.(call.arguments) ?? tool.actions[0]?.name ?? "call";
      const dangerous = tool.actions.find((entry) => entry.name === action)?.dangerous ?? false;
      const effect = decideToolPermission(plan.permissions, tool.name, action, dangerous);

      if (effect === "ask") {
        // Suspend: the call stays at the head of `pending` so a resume knows
        // exactly what it is deciding about.
        return {
          status: "waiting_approval",
          content: "",
          usage,
          checkpoint: { frames, usage, iterations },
          request: {
            agentName: frame.agentName,
            toolName: tool.name,
            action,
            input: call.arguments,
            toolCallId: call.id,
          },
        };
      }

      frame.pending.shift();
      if (effect === "deny") {
        await deps.onStep({
          type: "tool_call",
          agentName: frame.agentName,
          data: { tool: tool.name, action, arguments: call.arguments, effect, executed: false },
        });
        frame.messages.push({
          role: "tool",
          content: refusalMessage(tool.name, "deny"),
          toolCallId: call.id,
        });
        continue;
      }

      await execute(frame, call, tool, action);
    }
    if (delegated) continue;

    // 2. Ask the model what to do next.
    if (iterations >= maxIterations) {
      await deps.onStep({
        type: "error",
        agentName: frame.agentName,
        data: { message: `stopped after ${maxIterations} model calls without a final answer` },
      });
      return { status: "limit_reached", content: "", usage };
    }
    iterations++;

    const agent = agentFor(frame.agentName);
    const provider = await deps.getProvider(agent.model.provider);
    const definitions = [
      ...(frames.length <= maxDepth ? delegationDefinitions(agent, plan) : []),
      ...(await toolsFor(frame.agentName)).map(toolDefinition),
    ];

    const request = {
      model: agent.model.model,
      // A copy: the loop keeps appending to the frame, and an adapter that
      // held the live array would see turns that were not part of its request.
      messages: [...frame.messages],
      ...(definitions.length ? { tools: definitions } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}),
    };

    // Stream when someone is watching and the adapter supports it; otherwise
    // one request either way — streaming is a delivery detail, not a mode.
    const result =
      deps.onDelta && provider.streamComplete
        ? await provider.streamComplete(request, (text) =>
            deps.onDelta?.({ agentName: frame.agentName, text }),
          )
        : await provider.complete(request);
    usage = addUsage(usage, result.usage);

    await deps.onStep({
      type: "model_call",
      agentName: frame.agentName,
      data: {
        model: result.model ?? agent.model.model,
        provider: agent.model.provider,
        stopReason: result.stopReason,
        content: result.message.content,
      },
      usage: result.usage,
    });
    frame.messages.push(result.message);

    const toolCalls = result.message.toolCalls ?? [];
    if (result.stopReason === "tool_use" && toolCalls.length > 0) {
      frame.pending = [...toolCalls];
      continue;
    }

    // A refusal at the top ends the run; inside a subagent it is that
    // subagent's answer, and the parent decides what to do about it.
    if (result.stopReason === "refusal" && frames.length === 1) {
      return { status: "refused", content: result.message.content, usage };
    }

    // 3. This frame is done — return its answer to its parent, or finish.
    frames.pop();
    const parent = frames.at(-1);
    if (!parent) return { status: "succeeded", content: result.message.content, usage };

    await deps.onStep({
      type: "delegation",
      agentName: parent.agentName,
      data: {
        to: frame.agentName,
        task: String(frame.messages[1]?.content ?? ""),
        result: result.message.content,
      },
    });
    parent.messages.push({
      role: "tool",
      content: result.message.content,
      toolCallId: frame.returnToolCallId ?? "",
    });
  }

  return { status: "succeeded", content: "", usage };
}
