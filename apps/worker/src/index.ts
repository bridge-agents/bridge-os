import { createLogger, loadEnv } from "@bridge/core";
import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { processJob, RUNS_QUEUE } from "./jobs.js";

const env = loadEnv(
  z.object({
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  }),
);

const logger = createLogger("bridge-worker");
const redis = new URL(env.REDIS_URL);
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  password: redis.password || undefined,
};

const queue = new Queue(RUNS_QUEUE, { connection });

// Repeatable heartbeat proves scheduling end to end; Phase 8 builds real
// schedules on the same mechanism.
await queue.upsertJobScheduler("heartbeat", { every: 60_000 }, { name: "heartbeat" });

const worker = new Worker(
  RUNS_QUEUE,
  async (job) => processJob({ name: job.name, data: job.data ?? {} }, { logger }),
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

worker.on("completed", (job) => logger.debug({ job: job.name, id: job.id }, "job completed"));
worker.on("failed", (job, err) => logger.error({ job: job?.name, id: job?.id, err }, "job failed"));

logger.info({ queue: RUNS_QUEUE, concurrency: env.WORKER_CONCURRENCY }, "bridge worker started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await worker.close();
    await queue.close();
    process.exit(0);
  });
}
