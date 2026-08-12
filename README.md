# Bridge Agent OS

**Bridge** is an Agent Operating System and agentic harness generator: the
user describes the AI system they want, Bridge builds the agentic
infrastructure required to operate it.

> Status: foundation phase complete. Product docs: [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) ·
> [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`ROADMAP.md`](ROADMAP.md) ·
> [ADRs](docs/architecture/) · [`HANDOFF_TO_OPUS.md`](HANDOFF_TO_OPUS.md)

## Prerequisites

- Node ≥ 22
- pnpm 10 (`corepack enable`)
- Docker (for local Postgres + Redis)

## Quick start

```bash
pnpm install
cp .env.example .env

# Start Postgres + Redis
pnpm infra:up

# Apply database migrations
pnpm db:migrate

# Run everything (api :4000, worker, web :3000)
pnpm dev
```

Open http://localhost:3000 — the Bridge shell shows live API + database
status. API health: http://localhost:4000/health

## Repository layout

```text
apps/
  api/       Control plane — Hono HTTP API
  worker/    Data plane — BullMQ background workers
  web/       Web client — Vite + React SPA
packages/
  spec/      @bridge/spec — Bridge Manifest, dashboard schema, permissions, events, templates
  sdk/       @bridge/sdk  — provider / tool / channel adapter interfaces
  core/      @bridge/core — ids, errors, env loading, structured logging
  db/        @bridge/db   — Drizzle schema, migrations, client
  ui/        @bridge/ui   — design tokens, brand assets
docs/architecture/  ADRs
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run api + worker + web in watch mode |
| `pnpm test` | Run all tests (db integration test needs `DATABASE_URL`) |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format |
| `pnpm build` | Production builds |
| `pnpm db:generate` | Generate SQL migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm infra:up` / `infra:down` | Start/stop local Postgres + Redis |

## Architecture in one paragraph

Bridge is a TypeScript modular monolith: a control-plane API and a data-plane
worker sharing one Postgres and one Redis, communicating only through the
database, queues, and typed events. The canonical artifact is the **Bridge
Manifest** (`@bridge/spec`) — a versioned, validated, provider-independent
description of an agent system that templates, manual configuration, and AI
generation all compile into. Providers, tools, and channels are adapters
behind `@bridge/sdk` interfaces; permissions are evaluated on every tool
call; every client (web, CLI, desktop, mobile, channels) consumes the same
public API. See `ARCHITECTURE.md`.
