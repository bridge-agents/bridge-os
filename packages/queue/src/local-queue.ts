import type { Job, JobHandler, JobQueue, QueueOptions } from "./types.js";

/**
 * In-process queue for the desktop local runtime: no Redis, no external
 * service, nothing for a consumer to install.
 *
 * ponytail: single-process FIFO with a concurrency cap. That is the whole
 * point — one desktop install is one process. Server and Cloud deployments
 * select the BullMQ driver instead, which is where multi-worker fan-out,
 * cross-process visibility, and retry backoff belong.
 */
export class LocalQueue implements JobQueue {
  readonly driver = "local" as const;

  private readonly pending: Job[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly concurrency: number;
  private handler?: JobHandler;
  private active = 0;
  private closed = false;

  constructor(private readonly options: QueueOptions) {
    this.concurrency = options.concurrency ?? 5;
  }

  async enqueue(name: string, data: Record<string, unknown> = {}): Promise<void> {
    if (this.closed) return;
    this.pending.push({ name, data });
    this.drain();
  }

  async schedule(name: string, everyMs: number, data: Record<string, unknown> = {}): Promise<void> {
    clearInterval(this.timers.get(name));
    // Deliberately referenced: a scheduled agent is the reason a local worker
    // process stays alive, so this timer must hold the event loop open.
    this.timers.set(
      name,
      setInterval(() => void this.enqueue(name, data), everyMs),
    );
    await this.enqueue(name, data);
  }

  process(handler: JobHandler): void {
    this.handler = handler;
    this.drain();
  }

  private drain(): void {
    if (!this.handler || this.closed) return;
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active += 1;
      this.handler(job)
        .catch((error) => this.options.onFailed?.(job, error))
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.pending.length = 0;
  }
}
