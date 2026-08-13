import { EventEmitter } from "node:events";

/**
 * In-process fan-out for live run activity.
 *
 * Everything here is an *optimisation*: the durable record of a run is its
 * rows in `runs` and `run_steps`, and a client that misses a bus event still
 * sees the truth by reading those. That is what lets the SSE endpoint work in
 * both topologies — with the runtime in-process (desktop) subscribers get
 * token-level deltas, and with a separate worker they get step and status
 * updates polled from the database.
 *
 * ponytail: a module-level emitter, so it fans out within one process only.
 * Cross-process delta streaming needs a shared bus (Redis pub/sub) and lands
 * with Bridge Cloud; the database fallback keeps servers correct until then.
 */
export type RunEvent =
  | { type: "delta"; runId: string; agentName: string; text: string }
  | { type: "step"; runId: string; seq: number; step: Record<string, unknown> }
  | { type: "status"; runId: string; status: string };

class RunBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A busy workspace can have many watchers on one run; the default cap of
    // 10 would log spurious leak warnings.
    this.emitter.setMaxListeners(0);
  }

  publish(event: RunEvent): void {
    this.emitter.emit(event.runId, event);
  }

  /** Returns an unsubscribe function; always call it when the client leaves. */
  subscribe(runId: string, handler: (event: RunEvent) => void): () => void {
    this.emitter.on(runId, handler);
    return () => this.emitter.off(runId, handler);
  }
}

export const runBus = new RunBus();
