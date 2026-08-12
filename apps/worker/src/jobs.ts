import { BridgeError, type Logger } from "@bridge/core";

/** Queue carrying all Bridge background jobs. Run execution lands here in Phase 3. */
export const RUNS_QUEUE = "bridge-runs";

export interface JobInput {
  name: string;
  data: Record<string, unknown>;
}

export interface JobDeps {
  logger: Logger;
}

/**
 * Job dispatch, kept free of BullMQ types so it unit-tests without Redis.
 * Phase 3 replaces the heartbeat with the run state machine.
 */
export async function processJob(job: JobInput, deps: JobDeps): Promise<Record<string, unknown>> {
  switch (job.name) {
    case "heartbeat":
      deps.logger.debug("heartbeat");
      return { ok: true, at: new Date().toISOString() };
    default:
      throw new BridgeError("internal", `unknown job "${job.name}"`);
  }
}
