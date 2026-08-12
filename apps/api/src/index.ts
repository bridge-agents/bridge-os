import { createLogger, generateSecretKey, loadEnv, parseSecretKey } from "@bridge/core";
import { createDb, isEmbeddedUrl } from "@bridge/db";
import { providerResolver, RunExecutor } from "@bridge/runtime";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { buildApp } from "./app.js";

const env = loadEnv(
  z.object({
    /**
     * postgres://… for servers, pglite:<path> for an embedded database. The
     * default needs no service running, which is what the desktop app ships.
     */
    DATABASE_URL: z.string().min(1).default("pglite:./.bridge/data"),
    BRIDGE_SECRET_KEY: z.string().optional(),
    API_PORT: z.coerce.number().int().default(4000),
    NODE_ENV: z.string().default("development"),
    /** Force the runtime in or out of this process; defaults to embedded-only. */
    BRIDGE_EMBEDDED_RUNTIME: z.enum(["1", "0"]).optional(),
  }),
);

const logger = createLogger("bridge-api");
const isProduction = env.NODE_ENV === "production";

if (!env.BRIDGE_SECRET_KEY) {
  if (isProduction) {
    logger.error(
      "BRIDGE_SECRET_KEY is required in production — stored secrets must survive restarts",
    );
    process.exit(1);
  }
  logger.warn(
    { generate: "openssl rand -base64 32" },
    "BRIDGE_SECRET_KEY not set — using an ephemeral key, stored credentials will not decrypt after restart",
  );
}
const secretKey = parseSecretKey(env.BRIDGE_SECRET_KEY ?? generateSecretKey());

const embedded = isEmbeddedUrl(env.DATABASE_URL);
const database = await createDb(env.DATABASE_URL);
// Embedded installs have no separate migrate step: the app owns its database.
if (embedded) await database.migrate();

const deps = { db: database.db, logger, secretKey, secureCookies: isProduction };
const app = buildApp(deps);

/**
 * With an embedded database the API *is* the whole Bridge runtime: PGlite is
 * single-process, so a separate worker could not open the same data directory.
 * Server deployments run `apps/worker` alongside instead.
 */
const hostRuntime = env.BRIDGE_EMBEDDED_RUNTIME ? env.BRIDGE_EMBEDDED_RUNTIME === "1" : embedded;
const executor = hostRuntime
  ? new RunExecutor({
      db: database.db,
      logger,
      getProvider: providerResolver(database.db, secretKey),
    })
  : undefined;
executor?.start();

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info(
    {
      port: info.port,
      database: env.DATABASE_URL.split(":")[0],
      runtime: hostRuntime ? "in-process" : "external worker",
    },
    "bridge api listening",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await executor?.stop();
      await database.close();
      process.exit(0);
    });
  });
}
