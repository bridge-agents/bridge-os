/**
 * Watching for decisions an agent is waiting on.
 *
 * A local agent that hits an `ask` permission stops until a human answers.
 * On the web that is a badge you notice next time you look; on a desktop,
 * where the window may be closed, it has to reach you — otherwise "waiting
 * for approval" is indistinguishable from "broken".
 *
 * Polling rather than a subscription: it is one cheap request a minute
 * against a loopback server, and it survives the runtime restarting
 * underneath it, which a long-lived stream would not.
 */
export interface PendingApproval {
  id: string;
  agentTitle: string | null;
  agentName: string;
  toolName: string;
  action: string;
}

export interface ApprovalWatcherOptions {
  /** Where the runtime is now — read each tick, because it can change. */
  apiUrl: () => string | undefined;
  onPending: (approval: PendingApproval) => void;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class ApprovalWatcher {
  /** Announced already: an approval must not notify once a minute forever. */
  private readonly seen = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: ApprovalWatcherOptions) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const base = this.options.apiUrl();
    if (!base) return;
    const get = this.options.fetchImpl ?? fetch;

    try {
      // Local mode has no accounts, so this is the one workspace on the
      // machine (ADR-0014); no credential to hold and none to leak.
      const spaces = (await (
        await get(`${base}/v1/workspaces`, { signal: AbortSignal.timeout(5_000) })
      ).json()) as { workspaces?: { id: string }[] };
      const workspaceId = spaces.workspaces?.[0]?.id;
      if (!workspaceId) return;

      const body = (await (
        await get(`${base}/v1/workspaces/${workspaceId}/approvals?status=pending`, {
          signal: AbortSignal.timeout(5_000),
        })
      ).json()) as { approvals?: PendingApproval[] };

      const pending = body.approvals ?? [];
      for (const approval of pending) {
        if (this.seen.has(approval.id)) continue;
        this.seen.add(approval.id);
        this.options.onPending(approval);
      }
      // Forget decided ones so the set cannot grow without bound across a
      // long-running session.
      const live = new Set(pending.map((approval) => approval.id));
      for (const id of this.seen) if (!live.has(id)) this.seen.delete(id);
    } catch {
      // The runtime is restarting, or not up yet. Next tick.
    }
  }
}
