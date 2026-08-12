import { createLogger, generateSecretKey, loadEnv, parseSecretKey } from "@bridge/core";
import { createDb, isEmbeddedUrl } from "@bridge/db";
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

const database = await createDb(env.DATABASE_URL);
// Embedded installs have no separate migrate step: the app owns its database.
if (isEmbeddedUrl(env.DATABASE_URL)) await database.migrate();

const app = buildApp({
  db: database.db,
  logger,
  secretKey,
  secureCookies: isProduction,
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info(
    { port: info.port, database: env.DATABASE_URL.split(":")[0] },
    "bridge api listening",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await database.close();
      process.exit(0);
    });
  });
}
