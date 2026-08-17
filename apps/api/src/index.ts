import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelManager } from "@bridge/channels";
import {
  apiAddressFile,
  appDataDir,
  createLogger,
  embeddedDatabaseUrl,
  generateSecretKey,
  loadEnv,
  loadOrCreateSecretKey,
  parseSecretKey,
  persistSecretKey,
} from "@bridge/core";
import { createDb, isEmbeddedUrl } from "@bridge/db";
import {
  AutomationRunner,
  EncryptedDbSecretStore,
  KnowledgeConsolidator,
  providerResolver,
  RunExecutor,
  rotateEncryptedSecrets,
  workspaceImageResolver,
  workspaceSearchResolver,
} from "@bridge/runtime";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { buildApp } from "./app.js";
import { ensureLocalAccount } from "./local.js";

const env = loadEnv(
  z.object({
    /**
     * postgres://… for servers. Left unset it is derived from the data
     * directory as an embedded database, which needs no service running —
     * that is what an installed Bridge uses.
     */
    DATABASE_URL: z.string().min(1).optional(),
    BRIDGE_SECRET_KEY: z.string().optional(),
    API_PORT: z.coerce.number().int().default(4000),
    NODE_ENV: z.string().default("development"),
    /** Force the runtime in or out of this process; defaults to embedded-only. */
    BRIDGE_EMBEDDED_RUNTIME: z.enum(["1", "0"]).optional(),
    /**
     * Local desktop mode: no accounts, loopback only. Defaults on for an
     * embedded database; servers and Cloud must have it off.
     */
    BRIDGE_LOCAL_MODE: z.enum(["1", "0"]).optional(),
    BRIDGE_DATA_DIR: z.string().min(1).optional(),
    /** Built web client to serve from this process; set by installed builds. */
    BRIDGE_WEB_DIR: z.string().min(1).optional(),
    BRIDGE_OIDC_ISSUER: z.url().optional(),
    BRIDGE_OIDC_CLIENT_ID: z.string().min(1).optional(),
    BRIDGE_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    BRIDGE_OIDC_REDIRECT_URI: z.url().optional(),
    BRIDGE_OIDC_NAME: z.string().min(1).default("Company SSO"),
    BRIDGE_OIDC_ALLOWED_DOMAINS: z.string().optional(),
  }),
);

const logger = createLogger("bridge-api");
const isProduction = env.NODE_ENV === "production";

/**
 * An installed app cannot keep its data next to its code — on macOS the
 * bundle is read-only and the working directory is wherever the OS launched
 * it. So data lives in the platform application-data directory, except for
 * repositories that already have a local `./.bridge`, which keep working
 * where they are rather than silently starting empty.
 */
const legacyDataDir = "./.bridge";
const dataDir =
  env.BRIDGE_DATA_DIR ??
  (existsSync(join(legacyDataDir, "data")) ? legacyDataDir : appDataDir(process.env));

mkdirSync(dataDir, { recursive: true });
const addressFile = apiAddressFile(dataDir);

const databaseUrl = env.DATABASE_URL ?? embeddedDatabaseUrl(dataDir);
const embedded = isEmbeddedUrl(databaseUrl);

/**
 * Servers keep an operator-owned key. Everywhere else Bridge owns it: the
 * OS credential store holds one master key, so restarting no longer orphans
 * the provider credentials someone connected (ADR-0016).
 */
if (isProduction && !embedded && !env.BRIDGE_SECRET_KEY) {
  logger.error(
    "BRIDGE_SECRET_KEY is required in production — stored secrets must survive restarts",
  );
  process.exit(1);
}
const keySource = await loadOrCreateSecretKey({
  dataDir,
  env: { BRIDGE_SECRET_KEY: env.BRIDGE_SECRET_KEY },
});
if (keySource.warning) logger.warn(keySource.warning);
const secretKey = parseSecretKey(keySource.value);

const database = await createDb(databaseUrl);
/**
 * Migrate on boot, on every driver.
 *
 * This used to run for embedded databases only, on the theory that a server
 * migrates as a deploy step. The theory cost people their first ten minutes:
 * an API pointed at a database nobody had migrated started perfectly and
 * then failed on the first write — signing up returned 500 from the very
 * first screen. Migrations are idempotent and take a lock, so running them
 * here is safe, and it makes booting the API the only step there is.
 */
await database.migrate();

/**
 * On your own machine there is nobody to authenticate to, so Bridge
 * provisions one owner and skips sign-in entirely. Deliberately tied to the
 * embedded database by default: a server pointed at real Postgres never
 * silently drops authentication.
 */
const localMode = env.BRIDGE_LOCAL_MODE ? env.BRIDGE_LOCAL_MODE === "1" : embedded;
const localAccount = localMode ? await ensureLocalAccount(database.db) : undefined;
const secretStore = new EncryptedDbSecretStore(database.db, secretKey);
const rotateSecretKey =
  localMode && !env.BRIDGE_SECRET_KEY
    ? async () => {
        const currentKey = Buffer.from(secretKey);
        const nextValue = generateSecretKey();
        const nextKey = parseSecretKey(nextValue);
        const rotatedSecrets = await rotateEncryptedSecrets(database.db, currentKey, nextKey);
        try {
          const persisted = await persistSecretKey(dataDir, nextValue);
          nextKey.copy(secretKey);
          return { rotatedSecrets, ...persisted };
        } catch (error) {
          await rotateEncryptedSecrets(database.db, nextKey, currentKey);
          throw error;
        }
      }
    : undefined;
const oidcRequested = Boolean(
  env.BRIDGE_OIDC_ISSUER || env.BRIDGE_OIDC_CLIENT_ID || env.BRIDGE_OIDC_REDIRECT_URI,
);
if (
  oidcRequested &&
  (!env.BRIDGE_OIDC_ISSUER || !env.BRIDGE_OIDC_CLIENT_ID || !env.BRIDGE_OIDC_REDIRECT_URI)
) {
  throw new Error(
    "BRIDGE_OIDC_ISSUER, BRIDGE_OIDC_CLIENT_ID and BRIDGE_OIDC_REDIRECT_URI must be set together",
  );
}
const oidc =
  env.BRIDGE_OIDC_ISSUER && env.BRIDGE_OIDC_CLIENT_ID && env.BRIDGE_OIDC_REDIRECT_URI
    ? {
        name: env.BRIDGE_OIDC_NAME,
        issuer: env.BRIDGE_OIDC_ISSUER,
        clientId: env.BRIDGE_OIDC_CLIENT_ID,
        clientSecret: env.BRIDGE_OIDC_CLIENT_SECRET,
        redirectUri: env.BRIDGE_OIDC_REDIRECT_URI,
        allowedEmailDomains: env.BRIDGE_OIDC_ALLOWED_DOMAINS?.split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      }
    : undefined;

const deps = {
  db: database.db,
  logger,
  secretKey,
  secureCookies: isProduction,
  localUserId: localAccount?.userId,
  dataDir,
  webDir: env.BRIDGE_WEB_DIR,
  rotateSecretKey,
  oidc,
};
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
      dataDir: join(dataDir, "agents"),
      attachmentDataDir: dataDir,
      secretStore,
      getSearchConfig: workspaceSearchResolver(database.db, secretStore),
      getImageConfig: workspaceImageResolver(database.db, secretStore),
    })
  : undefined;
executor?.start();

/**
 * Channels live wherever the runtime does. A refresh loop rather than a watch:
 * deploying an agent starts its bot within a minute, which is soon enough and
 * needs nothing to fire an event across processes.
 */
const channels = hostRuntime
  ? new ChannelManager({
      db: database.db,
      logger,
      secretStore,
    })
  : undefined;
const channelRefresh = channels
  ? setInterval(() => void channels.refresh().catch(() => undefined), 60_000)
  : undefined;
await channels?.refresh().catch((err) => logger.error({ err }, "channel startup failed"));

/**
 * Schedules and event automations live with the runtime, for the same reason
 * channels do: whatever process runs agents is the one that must be able to
 * start them.
 */
const automations = hostRuntime ? new AutomationRunner({ db: database.db, logger }) : undefined;
automations?.start();

/**
 * Understanding what was said, on its own clock. Runs wherever the runtime
 * does, and only ever between conversations — never in the path of a reply.
 */
const knowledge = hostRuntime
  ? new KnowledgeConsolidator({
      db: database.db,
      logger,
      getProvider: providerResolver(database.db, secretKey),
    })
  : undefined;
knowledge?.start();

const server = serve(
  {
    fetch: app.fetch,
    port: env.API_PORT,
    // Local mode answers without authentication, so it must never be
    // reachable from another machine. This is the boundary that makes
    // skipping sign-in safe rather than reckless.
    ...(localMode ? { hostname: "127.0.0.1" } : {}),
  },
  (info) => {
    /**
     * Publish the address. API_PORT=0 lets the OS pick a free one — which is
     * what an installed app wants, since it cannot assume 4000 is free — and
     * this file is how the desktop supervisor and a terminal `bridge` find
     * the running instance instead of guessing.
     */
    writeFileSync(addressFile, `http://127.0.0.1:${info.port}\n`);
    logger.info(
      {
        port: info.port,
        database: databaseUrl.split(":")[0],
        runtime: hostRuntime ? "in-process" : "external worker",
        mode: localMode ? "local (no sign-in, loopback only)" : "server",
        secretKey: keySource.storage,
      },
      "bridge api listening",
    );
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    rmSync(addressFile, { force: true });
    server.close(async () => {
      clearInterval(channelRefresh);
      await automations?.stop();
      await channels?.stop();
      await executor?.stop();
      await database.close();
      process.exit(0);
    });
  });
}
