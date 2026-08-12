# ADR-0009: Embedded Postgres (PGlite) for local installs; one schema, one migration set

Status: accepted (2026-08-12) — amends [ADR-0003](ADR-0003-postgres-drizzle.md)

## Context
ADR-0003 chose PostgreSQL. ADR-0008 requires a desktop install with no
service to run. The obvious move — SQLite for local, Postgres for server —
would fork the schema, the migrations, and the SQL dialect forever, and every
future feature would have to be written and tested twice.

## Decision
Use **PGlite** (real Postgres compiled to WASM, running in-process) as the
`local` driver, and postgres.js for servers. `createDb(url)` picks by URL:

```text
postgres://…       → server Postgres (dev, self-hosted, Cloud)
pglite:<path>      → embedded, persisted to a directory (desktop)
pglite:memory      → embedded, ephemeral (tests)
```

Both are the **same Postgres dialect**, so there is exactly one
`schema.ts`, one set of generated SQL migrations, and one set of queries.
`Db` is typed as Drizzle's dialect-agnostic `PgDatabase`, so no caller knows
which driver it has. Embedded installs run migrations at boot (the app owns
its database); server installs run them as a deploy step.

Rejected: SQLite/libSQL (dialect divergence, two schemas, jsonb and future
pgvector gaps); bundling a real Postgres binary per platform (packaging and
update burden on three operating systems).

## Consequences
- The desktop app ships a database with no installer, no port, no daemon.
- Tests run against embedded Postgres by default: real SQL, real constraints,
  real migrations, no Docker, isolated per test. This is what makes the
  API suite runnable anywhere.
- pgvector is available in PGlite as an extension, so Phase 3+ memory and
  knowledge features do not need a second storage decision for local.
- PGlite is single-connection and single-process. That matches one desktop
  install; anything with concurrent server processes uses the postgres driver.
