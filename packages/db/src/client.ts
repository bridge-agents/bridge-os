import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/**
 * One schema, one migration set, two drivers (ADR-0009):
 *
 *   postgres://…  → server Postgres (dev, self-hosted server, Cloud)
 *   pglite:<path> → embedded Postgres in-process (desktop local runtime)
 *   pglite:memory → ephemeral, for tests
 *
 * PGlite is real Postgres compiled to WASM, so the desktop runtime needs no
 * Docker, no service to install, and no dialect divergence: the same SQL
 * migrations run on both.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  /** Apply committed SQL migrations. Safe to call on every boot. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Migrations are read from disk at runtime, so a packaged build has to say
 * where they went: bundling collapses this module into one file and
 * `../migrations` no longer points anywhere real. A build that copies the
 * folder next to its bundle is found automatically; the env var is the
 * escape hatch for anything laid out differently.
 */
const bundledMigrations = fileURLToPath(new URL("./migrations", import.meta.url));
const MIGRATIONS_FOLDER =
  process.env.BRIDGE_MIGRATIONS_DIR ??
  (existsSync(bundledMigrations)
    ? bundledMigrations
    : fileURLToPath(new URL("../migrations", import.meta.url)));

export function isEmbeddedUrl(url: string): boolean {
  return url.startsWith("pglite:");
}

async function createEmbedded(url: string): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  const target = url.slice("pglite:".length);
  if (target !== "memory") {
    // PGlite creates only the leaf directory, so a nested data path would fail.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(target, { recursive: true });
  }
  const client = new PGlite(target === "memory" ? undefined : target);
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.close(),
  };
}

async function createServer(url: string): Promise<DbHandle> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");

  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: () => client.end(),
  };
}

/** Create a database handle for either deployment target. */
export function createDb(url: string): Promise<DbHandle> {
  return isEmbeddedUrl(url) ? createEmbedded(url) : createServer(url);
}

/** Liveness probe; throws when the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
