import { createLogger, loadEnv } from "@bridge/core";
import { createDb } from "@bridge/db";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { buildApp } from "./app.js";

const env = loadEnv(
  z.object({
    DATABASE_URL: z.string().min(1).optional(),
    API_PORT: z.coerce.number().int().default(4000),
  }),
);

const logger = createLogger("bridge-api");
const database = env.DATABASE_URL ? createDb(env.DATABASE_URL) : undefined;
if (!database) {
  logger.warn("DATABASE_URL not set — running without a database (health will report it)");
}

const app = buildApp({ logger, db: database?.db });

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info({ port: info.port }, "bridge api listening");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await database?.close();
      process.exit(0);
    });
  });
}
