import { BridgeError } from "@bridge/core";
import type { BridgeTool } from "@bridge/sdk";
import type { ToolGrant } from "@bridge/spec";
import { loadMcpTools, type McpServerConfig } from "./mcp.js";
import { nativeTools, type WebSearchConfig } from "./native.js";
import { type SandboxPolicy, sandboxRoot } from "./sandbox.js";

/**
 * Resolves a manifest's tool grants into executable tools for one agent.
 *
 * Grants name capabilities; the registry decides what actually backs them.
 * `http` grants are the native HTTP tool under a different name, and `mcp`
 * grants expand into one Bridge tool per remote tool.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, BridgeTool>();

  constructor(tools: BridgeTool[] = []) {
    for (const tool of tools) this.tools.set(tool.name, tool);
  }

  register(tool: BridgeTool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): BridgeTool | undefined {
    return this.tools.get(name);
  }

  list(): BridgeTool[] {
    return [...this.tools.values()];
  }

  /** Tools an agent may use, given the grant names on its manifest entry. */
  forGrants(grantNames: string[]): BridgeTool[] {
    return grantNames.flatMap((name) => {
      const exact = this.tools.get(name);
      if (exact) return [exact];
      // MCP grants expand to `<grant>.<tool>`; expose all of them.
      const expanded = this.list().filter((tool) => tool.name.startsWith(`${name}.`));
      return expanded;
    });
  }
}

export interface RegistryOptions {
  workspaceId: string;
  agentId: string;
  sandbox: { network: SandboxPolicy["network"]; filesystem: SandboxPolicy["filesystem"] };
  /** Base directory agent workspaces live under. */
  dataDir: string;
  search?: WebSearchConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Build the registry for one agent: native tools bound to its sandbox, plus
 * any MCP servers its manifest declares.
 */
export async function createRegistry(
  grants: ToolGrant[],
  options: RegistryOptions,
): Promise<ToolRegistry> {
  const policy: SandboxPolicy = {
    ...options.sandbox,
    root: sandboxRoot(options.dataDir, options.workspaceId, options.agentId),
  };

  const registry = new ToolRegistry(
    nativeTools(policy, { search: options.search, fetchImpl: options.fetchImpl }),
  );

  for (const grant of grants) {
    if (grant.kind !== "mcp") continue;
    const config = grant.config as unknown as McpServerConfig;
    const tools = await loadMcpTools({ ...config, name: grant.name });
    for (const tool of tools) registry.register(tool);
  }

  return registry;
}

/** Native grant names the runtime can back with an implementation. */
export const NATIVE_TOOLS = ["http", "filesystem", "shell", "web-search"] as const;

/**
 * Reject grants nothing can execute. Called at deploy time so a broken agent
 * fails before it runs, not in the middle of a task.
 */
export function assertGrantsSupported(grants: ToolGrant[]): void {
  const unsupported = grants.filter(
    (grant) =>
      (grant.kind === "native" &&
        !NATIVE_TOOLS.includes(grant.name as (typeof NATIVE_TOOLS)[number])) ||
      grant.kind === "custom",
  );
  if (unsupported.length === 0) return;

  throw new BridgeError(
    "validation_failed",
    `no implementation for tool(s): ${unsupported.map((grant) => grant.name).join(", ")}`,
    unsupported.map((grant) => ({
      path: "tools",
      message: `"${grant.name}" (${grant.kind}) has no implementation in this Bridge build`,
    })),
  );
}
