import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RuntimeStatus, RuntimeSupervisor } from "./supervisor.js";

/**
 * The supervisor against a real child process.
 *
 * Faking `spawn` would only test the parts that never break. What actually
 * goes wrong is a runtime that dies — during startup, once, or over and over
 * — and only a process that really exits exercises that.
 */
let dir: string;
const running: RuntimeSupervisor[] = [];

/**
 * A stand-in for the API: it publishes its address the way the real one
 * does, then behaves however the test asked.
 *
 * `starts` counts launches across restarts, so a fake can act differently
 * the second time; `onServed` runs after a health check has been answered,
 * which is the only deterministic way to crash a runtime that the
 * supervisor has definitely seen come up.
 */
function fakeRuntime({ onStart = "", onServed = "" } = {}): string {
  const file = join(dir, "fake-runtime.mjs");
  writeFileSync(
    file,
    `import { createServer } from "node:http";
     import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
     import { join } from "node:path";
     const dataDir = process.env.BRIDGE_DATA_DIR;
     const log = join(dataDir, "starts.log");
     const starts = (existsSync(log) ? readFileSync(log, "utf8").trim().split("\\n").length : 0) + 1;
     appendFileSync(log, "start\\n");
     ${onStart}
     let served = 0;
     const server = createServer((_req, res) => {
       served++;
       res.writeHead(200);
       res.end("{}");
       ${onServed}
     });
     server.listen(0, "127.0.0.1", () => {
       writeFileSync(join(dataDir, "api.url"), "http://127.0.0.1:" + server.address().port);
     });`,
  );
  return file;
}

function supervise(entry: string, onStatus?: (status: RuntimeStatus) => void): RuntimeSupervisor {
  const supervisor = new RuntimeSupervisor({
    entry,
    execPath: process.execPath,
    dataDir: dir,
    startTimeoutMs: 30_000,
    backoffMs: [10],
    maxRestarts: 2,
    onStatus,
  });
  running.push(supervisor);
  return supervisor;
}

async function waitFor(predicate: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the supervisor");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The address file is state, so every test gets its own directory.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bridge-supervisor-"));
});
afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("RuntimeSupervisor", () => {
  it("is ready only once the runtime actually answers", async () => {
    const supervisor = supervise(fakeRuntime());
    const url = await supervisor.start();

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(supervisor.status).toBe("ready");
    // A URL that does not serve yet is worse than no URL: the window opens
    // on a blank page and Bridge looks broken.
    expect((await fetch(`${url}/health`)).ok).toBe(true);
  });

  it("ignores an address left behind by a previous run", async () => {
    writeFileSync(join(dir, "api.url"), "http://127.0.0.1:9");
    const supervisor = supervise(fakeRuntime());

    const url = await supervisor.start();
    expect(url).not.toBe("http://127.0.0.1:9");
  });

  it("brings the runtime back after it crashes", async () => {
    // Dies once it has been seen to be healthy, but only on its first start.
    const seen: RuntimeStatus[] = [];
    const supervisor = supervise(
      fakeRuntime({ onServed: "if (starts === 1) setTimeout(() => process.exit(1), 20);" }),
      (status) => seen.push(status),
    );
    const first = await supervisor.start();

    // Recorded rather than polled: "restarting" lasts only as long as the
    // backoff, so a poll can step straight over it.
    await waitFor(() => seen.includes("restarting"));
    await waitFor(() => supervisor.status === "ready");

    expect((await fetch(`${supervisor.url}/health`)).ok).toBe(true);
    // A fresh process means a fresh port, and the window has to follow it.
    expect(supervisor.url).not.toBe(first);
  });

  it("stops trying when the runtime cannot stay up, and says so", async () => {
    const seen: RuntimeStatus[] = [];
    const supervisor = supervise(
      fakeRuntime({ onServed: "setTimeout(() => process.exit(1), 20);" }),
      (status) => seen.push(status),
    );
    await supervisor.start();

    // Restarting forever behind a window that never works is the failure
    // mode this policy exists to prevent.
    await waitFor(() => supervisor.status === "failed");
    expect(seen.filter((status) => status === "restarting")).toHaveLength(2);
  });

  it("does not restart a runtime that was deliberately stopped", async () => {
    const supervisor = supervise(fakeRuntime());
    await supervisor.start();

    await supervisor.stop();
    expect(supervisor.status).toBe("stopped");

    await pause(300);
    expect(supervisor.status).toBe("stopped");
  });

  it("fails a first start loudly rather than retrying behind an error", async () => {
    const supervisor = supervise(fakeRuntime({ onStart: "process.exit(1);" }));

    await expect(supervisor.start()).rejects.toThrow(/stopped while starting up/);
    await pause(300);
    expect(supervisor.status).not.toBe("ready");
  });
});
