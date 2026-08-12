import { createLogger, loadEnv } from "@bridge/core";
import { createQueue } from "@bridge/queue";
import { z } from "zod";
import { processJob, RUNS_QUEUE } from "./jobs.js";

const env = loadEnv(
  z.object({
    /** Unset means the in-process driver, which is what the desktop app uses. */
    REDIS_URL: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  }),
);

const logger = createLogger("bridge-worker");

const queue = createQueue(env.REDIS_URL, {
  name: RUNS_QUEUE,
  concurrency: env.WORKER_CONCURRENCY,
  onFailed: (job, error) => logger.error({ job: job.name, err: error }, "job failed"),
});

queue.process((job) => processJob(job, { logger }));

// Proves scheduling end to end on both drivers; Phase 8 replaces it with
// schedules compiled from agent manifests.
await queue.schedule("heartbeat", 60_000);

logger.info(
  { queue: RUNS_QUEUE, driver: queue.driver, concurrency: env.WORKER_CONCURRENCY },
  "bridge worker started",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await queue.close();
    process.exit(0);
  });
}
