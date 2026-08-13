import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./client.js";

/**
 * Starting Bridge is one command, not three.
 *
 * `bridge tui` and `bridge dashboard` bring up whatever they need and leave it
 * running in the background, so a first-time user types one thing and gets a
 * working system. This is the local-desktop path only — pointed at a remote
 * Bridge, these do nothing but check it is reachable, because starting someone
 * else's server is not ours to do.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

export const WEB_URL = "http://localhost:3000";

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    // A 2xx or any HTTP answer means something is listening and speaking.
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll until `url` answers, or give up so we never hang forever. */
async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Detached and fully redirected: the child outlives this CLI process, so
 * `bridge tui` can exit without killing the agent runtime behind it.
 */
function startBackground(entry: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [tsx, entry], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
}

export interface ServeOptions {
  apiUrl: string;
  out: (line: string) => void;
}

/**
 * Make sure the API is up, starting it if this machine owns it.
 * Returns once it answers; throws something actionable if it cannot.
 */
export async function ensureApi({ apiUrl, out }: ServeOptions): Promise<void> {
  if (await reachable(`${apiUrl}/health`)) return;

  if (!isLoopback(apiUrl)) {
    throw new CliError(`Can't reach Bridge at ${apiUrl}. Is that server running?`);
  }

  const entry = join(repoRoot, "apps", "api", "src", "index.ts");
  if (!existsSync(entry)) {
    throw new CliError(`Can't reach Bridge at ${apiUrl}, and no local install was found to start.`);
  }

  out("Starting Bridge…");
  const port = new URL(apiUrl).port || "4000";
  startBackground(entry, join(repoRoot, "apps", "api"), { API_PORT: port });

  // Cold start includes creating and migrating the embedded database.
  if (!(await waitFor(`${apiUrl}/health`, 60_000))) {
    throw new CliError(
      "Bridge did not start within a minute. Run `pnpm dev` from the project root to see why.",
    );
  }
}

/** Same, for the web app that serves the dashboard. */
export async function ensureWeb(out: (line: string) => void): Promise<string> {
  if (await reachable(WEB_URL)) return WEB_URL;

  const web = join(repoRoot, "apps", "web");
  const vite = join(web, "node_modules", ".bin", "vite");
  if (!existsSync(vite)) {
    throw new CliError(`The dashboard is not installed. Run \`pnpm install\` in ${repoRoot}.`);
  }

  out("Starting the dashboard…");
  const child = spawn(vite, [], { cwd: web, detached: true, stdio: "ignore" });
  child.unref();

  if (!(await waitFor(WEB_URL, 60_000))) {
    throw new CliError("The dashboard did not start. Run `pnpm dev` from the project root.");
  }
  return WEB_URL;
}

/** Open a URL in the user's browser, best effort — never fatal. */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" })
    .on("error", () => undefined)
    .unref();
}
