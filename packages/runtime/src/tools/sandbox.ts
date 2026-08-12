import { lookup } from "node:dns/promises";
import { mkdir, realpath } from "node:fs/promises";
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
export async function resolveWithin(root: string, requested: string): Promise<string> {
  const realRoot = await realpath(root).catch(async () => {
    await mkdir(root, { recursive: true });
    return realpath(root);
  });

  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested);

  // Walk up to the nearest existing ancestor so new files resolve too.
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

  const resolved = real ? resolve(real, ...suffix) : candidate;
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new BridgeError("forbidden", `path escapes the agent's workspace: ${requested}`);
  }
  return resolved;
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
