export interface Job {
  name: string;
  data: Record<string, unknown>;
}

export type JobHandler = (job: Job) => Promise<unknown>;

/**
 * Queue contract shared by the control plane (enqueue) and the data plane
 * (process). Two drivers implement it (ADR-0010): Redis/BullMQ for servers
 * and Cloud, in-process for the desktop local runtime.
 *
 * Durability lives in Postgres, not here: a run's state is persisted before
 * it is enqueued, so a lost queue entry is recoverable by rescanning for
 * unfinished runs. That invariant is what lets the local driver be simple.
 */
export interface JobQueue {
  readonly driver: "bullmq" | "local";
  enqueue(name: string, data?: Record<string, unknown>): Promise<void>;
  /** Register or update a repeating job. Idempotent by name. */
  schedule(name: string, everyMs: number, data?: Record<string, unknown>): Promise<void>;
  process(handler: JobHandler): void;
  close(): Promise<void>;
}

export interface QueueOptions {
  name: string;
  concurrency?: number;
  onFailed?: (job: Job, error: unknown) => void;
}
