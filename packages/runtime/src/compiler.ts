import { BridgeError } from "@bridge/core";
import type { Manifest, ModelRef, PermissionPolicy, ToolGrant } from "@bridge/spec";

/**
 * The harness compiler: Manifest → RuntimePlan.
 *
 * The Manifest is the user-facing, portable description; the plan is what the
 * loop actually executes, with every indirection already resolved (model roles
 * → concrete ModelRefs, tool names → grants). Resolving once, up front, means
 * a misconfigured agent fails before it burns a single token.
 */
export interface AgentPlan {
  name: string;
  instructions: string;
  model: ModelRef;
  tools: ToolGrant[];
  canDelegateTo: string[];
  memory?: { working: boolean; longTerm: boolean };
  secrets?: string[];
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  serviceTier?: "default" | "fast";
}

export interface RuntimePlan {
  entryAgent: string;
  agents: Record<string, AgentPlan>;
  /** Every tool grant in the manifest, so one registry serves the whole run. */
  tools: ToolGrant[];
  permissions: PermissionPolicy;
  limits: {
    maxConcurrentRuns: number;
    maxRunSeconds: number;
    dailyTokenBudget?: number;
    dailySpendUsd?: number;
  };
  sandbox: {
    network: "none" | "restricted" | "full";
    filesystem: "none" | "workspace" | "full";
    /** Directories outside the agent's own workspace it may also work in. */
    allowedPaths: string[];
  };
  deployment: { target: string; background: boolean };
  memory?: { longTerm: boolean; knowledge: boolean };
}

export function compile(manifest: Manifest): RuntimePlan {
  const toolsByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const agents: Record<string, AgentPlan> = {};

  for (const agent of manifest.agents) {
    // A named role must exist in models.roles; no role means the default model.
    const model = agent.model ? manifest.models.roles[agent.model] : manifest.models.default;
    if (!model) {
      throw new BridgeError(
        "validation_failed",
        `agent "${agent.name}" references unknown model role "${agent.model}"`,
      );
    }

    agents[agent.name] = {
      name: agent.name,
      instructions: agent.instructions,
      model,
      tools: agent.tools.flatMap((name) => {
        const grant = toolsByName.get(name);
        if (!grant) {
          throw new BridgeError(
            "validation_failed",
            `agent "${agent.name}" references undeclared tool "${name}"`,
          );
        }
        return [grant];
      }),
      canDelegateTo: agent.canDelegateTo,
      memory: agent.memory,
      secrets: agent.secrets,
    };
  }

  if (!agents[manifest.entryAgent]) {
    throw new BridgeError(
      "validation_failed",
      `entryAgent "${manifest.entryAgent}" is not a defined agent`,
    );
  }

  return {
    entryAgent: manifest.entryAgent,
    agents,
    tools: manifest.tools,
    permissions: manifest.permissions,
    limits: manifest.runtime.limits,
    sandbox: manifest.runtime.sandbox,
    deployment: manifest.deployment,
    memory: manifest.memory,
  };
}

/** Every distinct provider the plan needs credentials for. */
export function requiredProviders(plan: RuntimePlan): string[] {
  return [...new Set(Object.values(plan.agents).map((agent) => agent.model.provider))];
}
