# Bridge Agent OS

**Bridge** is an Agent Operating System and agentic harness generator: the
user describes the AI system they want, Bridge builds the agentic
infrastructure required to operate it.

> Docs: [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) ·
> [`ROADMAP.md`](ROADMAP.md) · [ADRs](docs/architecture/) ·
> [`HANDOFF_TO_OPUS.md`](HANDOFF_TO_OPUS.md)

## Quick start

Needs Node ≥ 22 and pnpm 10 (`corepack enable`). **No Docker required.**

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open http://localhost:3000, create an account, and you have a workspace with
agents. The database is embedded (Postgres compiled to WASM, stored in
`apps/api/.bridge/data`) and the job queue runs in-process, so there is
nothing to install, start, or configure.

### Optional: run against Postgres + Redis

For server-shaped development, mirroring a self-hosted deployment:

```bash
pnpm infra:up      # docker compose: postgres:17, redis:7
pnpm db:migrate    # server databases migrate as a deploy step
DATABASE_URL=postgres://bridge:bridge@localhost:5432/bridge \
REDIS_URL=redis://localhost:6379 pnpm dev
```

Same schema, same migrations, same code — only the drivers differ (ADR-0009,
ADR-0010).

## Where Bridge runs

| Mode | Runtime | User-facing infrastructure |
|---|---|---|
| **Local desktop** | The user's device, supervised by the Bridge app | None |
| **Self-hosted server** | A server you run (Docker/Compose or Node) | Yours |
| **Bridge Cloud** | Bridge infrastructure | None |

An agent's manifest is portable across all three: moving between them is one
field (`deployment.target`), not a rebuild. Runtime location is independent
of model location — a locally running agent can still use hosted APIs.

## Repository layout

```text
apps/
  api/       Control plane — Hono HTTP API (auth, workspaces, agents, providers)
  worker/    Data plane — background jobs and schedules
  web/       Web client — Vite + React SPA
packages/
  spec/      @bridge/spec  — Bridge Manifest, dashboard schema, permissions, events, templates
  sdk/       @bridge/sdk   — provider / tool / channel adapter interfaces
  core/      @bridge/core  — ids, errors, env, logging, crypto
  db/        @bridge/db    — Drizzle schema, migrations, server + embedded drivers
  queue/     @bridge/queue — JobQueue interface, BullMQ + in-process drivers
  ui/        @bridge/ui    — design tokens, brand assets
docs/architecture/  ADRs
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run api (:4000), worker and web (:3000) in watch mode |
| `pnpm test` | Full test suite (runs against embedded Postgres) |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format |
| `pnpm build` | Production builds |
| `pnpm db:generate` | Generate SQL migration after editing `schema.ts` |
| `pnpm db:migrate` | Apply migrations to a server database |
| `pnpm infra:up` / `infra:down` | Optional Postgres + Redis for server-mode dev |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `pglite:./.bridge/data` | `postgres://…` for a server, `pglite:<path>` embedded |
| `REDIS_URL` | unset | Set to use BullMQ; unset runs the queue in-process |
| `BRIDGE_SECRET_KEY` | generated in dev | Base64 32-byte key encrypting stored credentials. **Required in production** — without a stable key, saved provider keys cannot be decrypted after a restart. Generate with `openssl rand -base64 32`. |
| `API_PORT` | `4000` | API port |

## Security notes

Passwords are scrypt-hashed with OWASP parameters; session tokens are stored
only as hashes; provider credentials are encrypted with AES-256-GCM and never
returned by the API (only a masked hint like `sk-…f4a2`). Every domain table
is workspace-scoped and cross-tenant access is covered by dedicated tests.
