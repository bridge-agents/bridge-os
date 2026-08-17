import { lookup } from "node:dns/promises";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BridgeError } from "@bridge/core";

/**
 * Enforcement for `runtime.sandbox` in the Manifest.
 *
 * These are real boundaries, not advisory flags: filesystem access is
 * confined by resolving symlinks before the check, and restricted network
 * access resolves DNS and rejects private address space so a hostname cannot
 * be pointed at the loopback interface or a metadata endpoint.
 */
export type NetworkPolicy = "none" | "restricted" | "full";
export type FilesystemPolicy = "none" | "workspace" | "full";

export interface SandboxPolicy {
  network: NetworkPolicy;
  filesystem: FilesystemPolicy;
  /** Directory a `workspace`-scoped agent may touch. */
  root: string;
  /**
   * Directories outside the agent's own workspace it may also work in,
   * from `runtime.sandbox.allowedPaths`.
   *
   * This is how an agent gets at your actual files — a notes folder, a
   * project — without being handed the whole machine. Naming them is the
   * point: a list you wrote is auditable in a way `filesystem: "full"` is
   * not.
   */
  allowedPaths?: string[];
}

/** Where a resolved path sits, which decides whether it needs an approval. */
export type PathScope = "workspace" | "allowed" | "outside";

export interface ResolvedPath {
  path: string;
  scope: PathScope;
}

export function sandboxRoot(baseDir: string, workspaceId: string, agentId: string): string {
  return join(baseDir, workspaceId, agentId);
}

/**
 * Resolve a model-supplied path inside the sandbox root, or refuse.
 *
 * Symlinks are resolved first (on the deepest existing ancestor, so paths
 * being created are covered too) — a check on the literal string would let
 * `link -> /etc` through.
 */
/** Confine to one root. Kept for callers that only ever mean the workspace. */
export async function resolveWithin(root: string, requested: string): Promise<string> {
  await mkdir(root, { recursive: true }).catch(() => undefined);
  const { path } = await resolvePath({ network: "none", filesystem: "workspace", root }, requested);
  return path;
}

/**
 * Resolve a model-supplied path against everything this agent may touch, and
 * say where it landed.
 *
 * The scope matters as much as the path: writing inside the agent's own
 * workspace is ordinary, writing to a folder you explicitly allowed is
 * expected, and writing anywhere else on your machine is something you
 * should be asked about — even for an agent set to `full`.
 */
export async function resolvePath(policy: SandboxPolicy, requested: string): Promise<ResolvedPath> {
  assertFilesystemAllowed(policy);
  await mkdir(policy.root, { recursive: true }).catch(() => undefined);
  const resolved = await realpathish(expandHome(requested), policy.root);

  const workspace = await realpath(policy.root).catch(() => policy.root);
  if (contains(workspace, resolved)) return { path: resolved, scope: "workspace" };

  for (const allowed of policy.allowedPaths ?? []) {
    const real = await realpath(expandHome(allowed)).catch(() => resolve(expandHome(allowed)));
    if (contains(real, resolved)) return { path: resolved, scope: "allowed" };
  }

  if (policy.filesystem === "full") return { path: resolved, scope: "outside" };

  throw new BridgeError(
    "forbidden",
    `path is outside this agent's workspace: ${requested}. ` +
      'Add it to the agent\'s allowedPaths, or set its filesystem sandbox to "full".',
  );
}

/** `~` is what a person types; nothing downstream should have to know that. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith(`~${sep}`) || path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve symlinks on the deepest existing ancestor, so a path being created
 * is covered too — a check on the literal string would let `link -> /etc`
 * through.
 */
async function realpathish(requested: string, base: string): Promise<string> {
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  let probe = candidate;
  let real: string | undefined;
  const suffix: string[] = [];
  while (real === undefined) {
    real = await realpath(probe).catch(() => undefined);
    if (real === undefined) {
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      suffix.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
  return real ? resolve(real, ...suffix) : candidate;
}

export function assertFilesystemAllowed(policy: SandboxPolicy): void {
  if (policy.filesystem === "none") {
    throw new BridgeError("forbidden", "this agent has no filesystem access");
  }
}

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return PRIVATE_V4.test(address);
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    // IPv4-mapped addresses reach the same hosts.
    (lower.startsWith("::ffff:") && PRIVATE_V4.test(lower.slice(7)))
  );
}

/**
 * Check a URL against the network policy. `restricted` allows the public
 * internet only: the hostname is resolved and every returned address must be
 * public, which blocks localhost, link-local metadata services and private
 * ranges reached through a public-looking name.
 */
export async function assertNetworkAllowed(
  policy: SandboxPolicy,
  rawUrl: string,
  options: { allowHosts?: string[] } = {},
): Promise<URL> {
  if (policy.network === "none") {
    throw new BridgeError("forbidden", "this agent has no network access");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BridgeError("validation_failed", `not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BridgeError("forbidden", `unsupported protocol: ${url.protocol}`);
  }
  if (policy.network === "full") return url;

  // Explicitly allowed hosts (e.g. a configured local model endpoint) bypass
  // the private-address check; everything else must resolve to public space.
  if (options.allowHosts?.includes(url.hostname)) return url;

  const addresses = await lookup(url.hostname, { all: true }).catch(() => {
    throw new BridgeError("forbidden", `cannot resolve host: ${url.hostname}`);
  });
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new BridgeError(
        "forbidden",
        `${url.hostname} resolves to a private address (${address}); this agent may only reach the public internet`,
      );
    }
  }
  return url;
}
