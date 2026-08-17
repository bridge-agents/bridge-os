import { describe, expect, it } from "vitest";
import { ApprovalWatcher, type PendingApproval } from "./approvals.js";

/**
 * The notification rule that matters: tell someone once.
 *
 * A poll that notified on every tick would turn one paused agent into a
 * notification a minute, which people fix by turning notifications off —
 * and then they miss the one that mattered.
 */
const approval = (id: string): PendingApproval => ({
  id,
  agentTitle: "Research",
  agentName: "research",
  toolName: "shell",
  action: "run a command",
});

function watcherOver(pages: PendingApproval[][]) {
  const notified: PendingApproval[] = [];
  let tick = 0;

  const fetchImpl = (async (url: string | URL) => {
    const path = String(url);
    if (path.endsWith("/v1/workspaces")) {
      return Response.json({ workspaces: [{ id: "ws_1" }] });
    }
    const page = pages[Math.min(tick, pages.length - 1)] ?? [];
    tick += 1;
    return Response.json({ approvals: page });
  }) as unknown as typeof fetch;

  const watcher = new ApprovalWatcher({
    apiUrl: () => "http://127.0.0.1:4000",
    onPending: (item) => notified.push(item),
    fetchImpl,
  });
  return { watcher, notified };
}

describe("ApprovalWatcher", () => {
  it("announces a pending approval", async () => {
    const { watcher, notified } = watcherOver([[approval("apr_1")]]);
    await watcher.tick();

    expect(notified.map((item) => item.id)).toEqual(["apr_1"]);
  });

  it("does not announce the same one twice", async () => {
    const { watcher, notified } = watcherOver([[approval("apr_1")], [approval("apr_1")]]);
    await watcher.tick();
    await watcher.tick();

    expect(notified).toHaveLength(1);
  });

  it("announces a new one alongside an old one", async () => {
    const { watcher, notified } = watcherOver([
      [approval("apr_1")],
      [approval("apr_1"), approval("apr_2")],
    ]);
    await watcher.tick();
    await watcher.tick();

    expect(notified.map((item) => item.id)).toEqual(["apr_1", "apr_2"]);
  });

  it("announces again if the same approval returns after being decided", async () => {
    // Also the reason the seen-set is pruned: a session left open for days
    // must not accumulate every approval it has ever seen.
    const { watcher, notified } = watcherOver([[approval("apr_1")], [], [approval("apr_1")]]);
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();

    expect(notified).toHaveLength(2);
  });

  it("stays quiet while the runtime is down", async () => {
    const notified: PendingApproval[] = [];
    const watcher = new ApprovalWatcher({
      // No address published: the runtime is starting or restarting.
      apiUrl: () => undefined,
      onPending: (item) => notified.push(item),
      fetchImpl: (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch,
    });

    await expect(watcher.tick()).resolves.toBeUndefined();
    expect(notified).toHaveLength(0);
  });
});
