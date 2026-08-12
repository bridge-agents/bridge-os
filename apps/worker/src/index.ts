import { createLogger, loadEnv, parseSecretKey } from "@bridge/core";
import { createDb, isEmbeddedUrl } from "@bridge/db";
import { createQueue } from "@bridge/queue";
import { providerResolver, RunExecutor } from "@bridge/runtime";
import { z } from "zod";
import { processJob, RUNS_QUEUE } from "./jobs.js";

const env = loadEnv(
  z.object({
    DATABASE_URL: z.string().min(1).default("pglite:./.bridge/data"),
    BRIDGE_SECRET_KEY: z.string().optional(),
    /** Unset means the in-process queue driver for scheduled jobs. */
    REDIS_URL: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  }),
);

const logger = createLogger("bridge-worker");

/**
 * An embedded database is single-process, so the API already hosts the
 * runtime in that mode and a second process would only fight it for the data
 * directory. Say so plainly and exit rather than failing obscurely.
 */
if (isEmbeddedUrl(env.DATABASE_URL)) {
  logger.info(
    { database: env.DATABASE_URL },
    "embedded database detected — the API hosts the runtime in this mode; nothing for a separate worker to do",
  );
  process.exit(0);
}

if (!env.BRIDGE_SECRET_KEY) {
  logger.error("BRIDGE_SECRET_KEY is required — the worker decrypts provider credentials");
  process.exit(1);
}

const database = await createDb(env.DATABASE_URL);
const executor = new RunExecutor({
  db: database.db,
  logger,
  getProvider: providerResolver(database.db, parseSecretKey(env.BRIDGE_SECRET_KEY)),
});
executor.start();

// Scheduled jobs stay on the queue driver; runs are claimed from the database.
const queue = createQueue(env.REDIS_URL, {
  name: RUNS_QUEUE,
  concurrency: env.WORKER_CONCURRENCY,
  onFailed: (job, error) => logger.error({ job: job.name, err: error }, "job failed"),
});
queue.process((job) => processJob(job, { logger }));
await queue.schedule("heartbeat", 60_000);

logger.info(
  { queue: RUNS_QUEUE, driver: queue.driver, concurrency: env.WORKER_CONCURRENCY },
  "bridge worker started",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, "shutting down");
    await executor.stop();
    await queue.close();
    await database.close();
    process.exit(0);
  });
}
