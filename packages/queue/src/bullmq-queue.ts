import { Queue, Worker } from "bullmq";
import type { JobHandler, JobQueue, QueueOptions } from "./types.js";

/** Redis-backed driver for dev, self-hosted servers, and Cloud. */
export class BullMqQueue implements JobQueue {
  readonly driver = "bullmq" as const;

  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    redisUrl: string,
    private readonly options: QueueOptions,
  ) {
    const url = new URL(redisUrl);
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
    };
    this.queue = new Queue(options.name, { connection: this.connection });
  }

  private readonly connection: { host: string; port: number; password?: string };

  async enqueue(name: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.queue.add(name, data);
  }

  async schedule(name: string, everyMs: number, data: Record<string, unknown> = {}): Promise<void> {
    await this.queue.upsertJobScheduler(name, { every: everyMs }, { name, data });
  }

  process(handler: JobHandler): void {
    this.worker = new Worker(
      this.options.name,
      (job) => handler({ name: job.name, data: (job.data ?? {}) as Record<string, unknown> }),
      { connection: this.connection, concurrency: this.options.concurrency ?? 5 },
    );
    this.worker.on("failed", (job, error) => {
      if (job) this.options.onFailed?.({ name: job.name, data: job.data ?? {} }, error);
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
