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
cd apps/cli && pnpm link --global    # puts `bridge` on your PATH
bridge
```

That is the whole setup. `bridge` starts Bridge if it isn't running, asks two
questions the first time (which model provider, which model), creates and
deploys a starter agent, and drops you into a conversation with it. Prefer a
browser? `bridge dashboard` does the same and opens the dashboard.

**Running locally, there is no account.** No signup, no login, no password:
the database is a file on your machine and the server listens on loopback
only, so Bridge provisions a single owner for you and remembers this device.
Accounts exist for self-hosted servers and Bridge Cloud, where more than one
person can reach the same install.

Agents can use tools (HTTP, files, shell, search, and any MCP server) inside
an enforced sandbox. Anything destructive pauses the run and waits for you in
the Approvals queue — nothing runs until you decide.

The database is embedded (Postgres compiled to WASM, stored in
`apps/api/.bridge/data`) and the agent runtime runs inside the API process, so
there is nothing to install, start, or configure. Any OpenAI-compatible
endpoint works as a provider, including a local Ollama or LM Studio — so you
can run Bridge end to end with no hosted API key at all.

### Everyday commands

| Command | What it does |
|---|---|
| `bridge` | Start Bridge and chat with your agent |
| `bridge dashboard` | Start Bridge and open the web dashboard |
| `bridge status` | Health, agents, pending approvals |
| `bridge agent list` | Your agents |
| `bridge approvals` | What is waiting on you |

Working on the code itself? `pnpm dev` still runs the API and web app in the
foreground with hot reload, which is what you want when editing them.

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
  api/       Control plane — Hono HTTP API (auth, workspaces, agents, runs, architect)
  worker/    Data plane — hosts the run executor for server deployments
  web/       Web client — Vite + React SPA (agents, chat, approvals, providers)
  cli/       `bridge` command line — same public API, bearer tokens
packages/
  spec/      @bridge/spec      — Bridge Manifest, dashboard schema, permissions, events, templates
  sdk/       @bridge/sdk       — provider / tool / channel adapter interfaces
  core/      @bridge/core      — ids, errors, env, logging, crypto
  db/        @bridge/db        — Drizzle schema, migrations, server + embedded drivers
  queue/     @bridge/queue     — JobQueue interface, BullMQ + in-process drivers
  providers/ @bridge/providers — Anthropic + OpenAI-compatible adapters, pricing
  runtime/   @bridge/runtime   — compiler, agent loop, executor, tools, MCP, sandbox
  channels/  @bridge/channels  — Telegram + Discord adapters; inbound message → run
  ui/        @bridge/ui        — design tokens, brand assets
docs/architecture/  ADRs
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run api (:4000, hosts the runtime), worker and web (:3000) |
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
| `REDIS_URL` | unset | Set to use BullMQ for scheduled jobs; unset runs them in-process |
| `BRIDGE_EMBEDDED_RUNTIME` | auto | `1`/`0` to force the run executor in or out of the API process |
| `BRIDGE_SECRET_KEY` | generated in dev | Base64 32-byte key encrypting stored credentials. **Required in production** — without a stable key, saved provider keys cannot be decrypted after a restart. Generate with `openssl rand -base64 32`. |
| `API_PORT` | `4000` | API port |

## Security notes

Passwords are scrypt-hashed with OWASP parameters; session tokens are stored
only as hashes; provider credentials are encrypted with AES-256-GCM and never
returned by the API (only a masked hint like `sk-…f4a2`).

Agent tools run inside a sandbox: filesystem access is confined to the agent's
own directory (resolved through symlinks, so links cannot escape), restricted
network access rejects private and loopback addresses after a DNS lookup, and
shell commands take an argument vector with a minimal environment. Destructive
actions require an explicit permission rule or a human approval — a permissive
default is never enough. Every domain table
is workspace-scoped and cross-tenant access is covered by dedicated tests.
