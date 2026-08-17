import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { apiAddressFile } from "@bridge/core";

/**
 * The local runtime supervisor.
 *
 * A desktop user has no terminal and no way to notice that a background
 * process died, so the app owns the runtime's whole life: start it, wait for
 * it to actually answer, restart it if it crashes, and — the part that
 * matters most — stop pretending after repeated failures and say so, rather
 * than restarting forever behind a window that never loads.
 *
 * Deliberately free of any Electron import: this is the piece with real
 * failure modes, so it has to be testable without a display.
 */
export type RuntimeStatus = "starting" | "ready" | "restarting" | "stopped" | "failed";

export interface SupervisorOptions {
  /** The built API bundle to run. */
  entry: string;
  /** Binary to run it with — Electron itself, in ELECTRON_RUN_AS_NODE mode. */
  execPath: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  onStatus?: (status: RuntimeStatus, detail?: string) => void;
  onLog?: (line: string) => void;
  /** How long a cold start may take — first launch also creates the database. */
  startTimeoutMs?: number;
  /** Restart policy, overridable so tests do not wait out real backoff. */
  backoffMs?: number[];
  maxRestarts?: number;
}

/**
 * Crash-loop policy. A runtime that dies immediately, repeatedly, is broken
 * in a way restarting will not fix; a runtime that dies after an hour is a
 * blip worth recovering from. So the counter resets once a start sticks.
 */
const MAX_RESTARTS = 5;
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];
const STABLE_MS = 60_000;

export class RuntimeSupervisor {
  private child?: ChildProcess;
  private wanted = false;
  private restarts = 0;
  private startedAt = 0;
  private timer?: NodeJS.Timeout;

  status: RuntimeStatus = "stopped";
  /** Where the runtime is listening, once it is ready. */
  url?: string;

  constructor(private readonly options: SupervisorOptions) {}

  /** Start the runtime and resolve when it answers. Throws if it cannot. */
  async start(): Promise<string> {
    this.wanted = true;
    this.restarts = 0;
    try {
      return await this.launch();
    } catch (err) {
      // A first start that fails is reported, not retried behind the user's
      // back: retrying silently leaves them looking at an error dialog while
      // something churns underneath it.
      this.wanted = false;
      clearTimeout(this.timer);
      throw err;
    }
  }

  private async launch(): Promise<string> {
    this.set("starting");
    const address = apiAddressFile(this.options.dataDir);
    // A file left by a previous run would look like a healthy start, so the
    // absence of this file is what "not up yet" means.
    rmSync(address, { force: true });
    this.url = undefined;

    const child = spawn(this.options.execPath, [this.options.entry], {
      env: {
        ...process.env,
        ...this.options.env,
        // Electron's binary doubles as Node; this is how the app runs a
        // server without shipping a second runtime alongside it.
        ELECTRON_RUN_AS_NODE: "1",
        // Let the OS choose: an installed app cannot assume 4000 is free.
        API_PORT: "0",
        BRIDGE_DATA_DIR: this.options.dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();

    const log = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) this.options.onLog?.(line);
      }
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.on("exit", (code, signal) => this.onExit(code, signal));
    // A binary that will not launch at all never emits "exit", so it needs
    // the same treatment or the supervisor waits forever.
    child.on("error", (err) => this.onExit(null, null, err.message));

    const url = await this.waitForAddress(address, child);
    this.url = url;
    this.set("ready");
    return url;
  }

  /**
   * Wait for the runtime to publish its address and answer a health check.
   * "The process is alive" is not the same as "Bridge works" — a window
   * opened on a port that is not serving yet is a blank screen.
   */
  private async waitForAddress(address: string, child: ChildProcess): Promise<string> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("the Bridge runtime stopped while starting up");
      }
      const url = (await readFile(address, "utf8").catch(() => ""))?.trim();
      if (url && (await healthy(url))) return url;
      await delay(250);
    }
    child.kill();
    throw new Error("the Bridge runtime did not start in time");
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error?: string): void {
    if (!this.child) return;
    this.child = undefined;
    if (!this.wanted) {
      this.set("stopped");
      return;
    }

    // A run that lasted long enough to be healthy earns a clean slate.
    if (Date.now() - this.startedAt > STABLE_MS) this.restarts = 0;

    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    if (this.restarts >= (this.options.maxRestarts ?? MAX_RESTARTS)) {
      this.set(
        "failed",
        "Bridge's local runtime keeps stopping. Restart Bridge, or check the log for why.",
      );
      return;
    }

    const wait = backoff[Math.min(this.restarts, backoff.length - 1)] ?? 10_000;
    this.restarts += 1;
    this.set("restarting", error ?? (signal ? `stopped by ${signal}` : `exited with code ${code}`));
    this.timer = setTimeout(() => {
      // One owner for the restart policy: a relaunch that fails comes back
      // through this same exit path, so the backoff and the give-up rule
      // keep applying instead of two handlers racing to decide.
      void this.launch().catch(() => undefined);
    }, wait);
  }

  /** Stop the runtime and stay stopped. */
  async stop(): Promise<void> {
    this.wanted = false;
    clearTimeout(this.timer);
    const child = this.child;
    if (!child) {
      this.set("stopped");
      return;
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // SIGTERM so the API closes its database cleanly; SIGKILL only if it hangs.
    child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forced);
    this.set("stopped");
  }

  private set(status: RuntimeStatus, detail?: string): void {
    this.status = status;
    this.options.onStatus?.(status, detail);
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
