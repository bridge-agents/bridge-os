import { BridgeError } from "@bridge/core";
import type { BridgeTool } from "@bridge/sdk";
import type { ToolGrant } from "@bridge/spec";
import type { SecretStore } from "../secrets.js";
import { loadMcpTools, type McpServerConfig } from "./mcp.js";
import { type ImageConfig, nativeTools, type WebSearchConfig } from "./native.js";
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
  sandbox: {
    network: SandboxPolicy["network"];
    filesystem: SandboxPolicy["filesystem"];
    /** Directories outside the agent's own workspace it may also work in. */
    allowedPaths?: string[];
  };
  /** Base directory agent workspaces live under. */
  dataDir: string;
  search?: WebSearchConfig;
  image?: ImageConfig;
  fetchImpl?: typeof fetch;
  secretStore?: SecretStore;
  allowedSecrets?: readonly string[];
}

function setConfigPath(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0)
    throw new BridgeError("validation_failed", "secret binding path is empty");
  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
    }
  }
  const leaf = parts.at(-1);
  if (leaf) cursor[leaf] = value;
}

async function resolveGrantSecrets(grant: ToolGrant, options: RegistryOptions): Promise<ToolGrant> {
  const bindings = grant.secretBindings ?? {};
  if (Object.keys(bindings).length === 0) return grant;
  if (!options.secretStore) {
    throw new BridgeError("validation_failed", `tool "${grant.name}" needs a secret store`);
  }
  const allowed = new Set(options.allowedSecrets ?? []);
  const config = structuredClone(grant.config);
  for (const [path, secretName] of Object.entries(bindings)) {
    if (!allowed.has(secretName)) {
      throw new BridgeError(
        "forbidden",
        `agent is not allowed to use secret "${secretName}" for tool "${grant.name}"`,
      );
    }
    const value = await options.secretStore.revealNamed(options.workspaceId, secretName);
    if (!value) throw new BridgeError("not_found", `secret "${secretName}" is unavailable`);
    setConfigPath(config, path, value);
  }
  return { ...grant, config };
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
    nativeTools(policy, {
      search: options.search,
      image: options.image,
      fetchImpl: options.fetchImpl,
    }),
  );

  for (const grant of grants) {
    if (grant.kind !== "mcp") continue;
    const resolved = await resolveGrantSecrets(grant, options);
    const config = resolved.config as unknown as McpServerConfig;
    const tools = await loadMcpTools({ ...config, name: resolved.name });
    for (const tool of tools) registry.register(tool);
  }

  return registry;
}

/** Native grant names the runtime can back with an implementation. */
export const NATIVE_TOOLS = ["http", "filesystem", "shell", "web-search", "image"] as const;

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
