# Bridge Agent OS

**Bridge** is an Agent Operating System and agentic harness generator: the
user describes the AI system they want, Bridge builds the agentic
infrastructure required to operate it.

> Docs: [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) ·
> [`ROADMAP.md`](ROADMAP.md) · [ADRs](docs/architecture/) ·
> [`HANDOFF_TO_OPUS.md`](HANDOFF_TO_OPUS.md)

## Install it

Open the app. There is nothing to configure, install alongside it, or start:
Bridge supervises its own runtime, keeps its database in the usual place for
your platform, and picks its own port.

```bash
pnpm install
pnpm --filter @bridge/api build      # the runtime the app supervises
pnpm --filter @bridge/web build      # the client the runtime serves
pnpm --filter @bridge/desktop dist   # → apps/desktop/release
```

That produces a `.dmg` on macOS, an installer on Windows and an AppImage or
`.deb` on Linux. Builds are unsigned today, so macOS will warn on first open
until Bridge has a Developer ID.

**Running locally, there is no account.** No signup, no login, no password:
the database is a file on your machine and the server listens on loopback
only, so Bridge provisions a single owner for you and remembers this device.
Accounts exist for self-hosted servers and Bridge Cloud, where more than one
person can reach the same install.

Closing the window stops your agents unless you turn on background operation,
and the menu-bar item says which is true — an app that keeps spending money
after you close it should never be something you find out about later.

## What you get

Attach a dashboard to any agent — from a template, or by describing what you
want to see — and it renders live workspace data: spend, runs, failures, and
whatever is waiting on you. Say "put my costs at the top" and Bridge proposes
a change you preview before applying.

Agents work with files the way you would: read, list, glob and grep to find
things, then write, edit, move or delete to change them. `edit` replaces an
exact fragment rather than rewriting a whole file, so an agent cannot quietly
drop the parts it did not think about.

By default an agent only sees its own workspace. To let one into your actual
files, name the folders in its manifest:

```json
"runtime": { "sandbox": { "allowedPaths": ["~/Documents/notes", "~/code/site"] } }
```

Naming folders beats `"filesystem": "full"` because the list is something you
can read back later. Either way, writing, deleting, and anything reaching
outside the agent's own workspace pauses the run and waits for you in the
Approvals queue — nothing runs until you decide.

Agents can also use HTTP, shell, search, and any MCP server, inside the same
enforced sandbox.

Give an agent a schedule and it runs on its own: a cron time in your own
timezone ("weekdays at 9am" means 9am where you are), or an interval like
`every: "15m"`. Loops can be told where to stop — after ten runs, until
Friday, or after five failures in a row — because an automation nobody stops
is one you find out about from the bill. The Automations page shows what runs
next and why anything stopped.

Type `/` in any chat box to run Bridge commands without leaving the
conversation — `/automations`, `/approve`, `/deploy`, `/usage`. They are the
same commands the `bridge` CLI runs, defined once.

The database is embedded (Postgres compiled to WASM) and the agent runtime
runs inside the API process, so there is nothing to install, start, or
configure. Any OpenAI-compatible endpoint works as a provider, including a
local Ollama or LM Studio — so you can run Bridge end to end with no hosted
API key at all.

Your data lives in the platform's application-data directory — on macOS
`~/Library/Application Support/Bridge`, on Windows `%APPDATA%\Bridge`, on
Linux `~/.local/share/bridge` — except in a source checkout that already has
a `./.bridge`, which keeps working where it is.

## Or from a terminal

Needs Node ≥ 22 and pnpm 10 (`corepack enable`). **No Docker required.**

```bash
pnpm install
cd apps/cli && pnpm link --global    # puts `bridge` on your PATH
bridge
```

`bridge` starts Bridge if it isn't running, asks two questions the first time
(which model provider, which model), creates and deploys a starter agent, and
drops you into a conversation with it. Inside that conversation, `/help` lists
what you can type — every Bridge command works there, the same ones the web
chat box runs.

Prefer a browser? `bridge dashboard` does the same and opens the dashboard. It finds a Bridge the desktop app
started, too — whatever port that one happens to be on.

### Everyday commands

| Command | What it does |
|---|---|
| `bridge` | Start Bridge and chat with your agent |
| `bridge dashboard` | Start Bridge and open the web dashboard |
| `bridge status` | Health, agents, pending approvals |
| `bridge agents` | Your agents |
| `bridge approvals` | What is waiting on you |
| `bridge automations` | Every schedule, when it next runs |
| `bridge pause` / `resume` | Stop and start an automation |
| `bridge trigger <name>` | Run an automation now |
| `bridge usage` | What your agents have spent |
| `bridge doctor` | Why something is not working |
| `bridge help` | Everything Bridge can do |

Working on the code itself? `pnpm dev` still runs the API and web app in the
foreground with hot reload, which is what you want when editing them.

### Optional: run against Postgres + Redis

For server-shaped development, mirroring a self-hosted deployment:

```bash
pnpm infra:up      # docker compose: postgres:17, redis:7
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
  web/       Web client — Vite + React SPA (chat, dashboards, agents, approvals)
  cli/       `bridge` command line — same public API, bearer tokens
  desktop/   Electron shell — supervises the local runtime, tray, notifications
packages/
  spec/      @bridge/spec      — Bridge Manifest, dashboard schema, permissions, events, templates
  sdk/       @bridge/sdk       — provider / tool / channel adapter interfaces
  core/      @bridge/core      — ids, errors, env, logging, crypto
  db/        @bridge/db        — Drizzle schema, migrations, server + embedded drivers
  queue/     @bridge/queue     — JobQueue interface, BullMQ + in-process drivers
  providers/ @bridge/providers — Anthropic + OpenAI-compatible adapters, pricing
  runtime/   @bridge/runtime   — compiler, agent loop, executor, tools, MCP, sandbox
  channels/  @bridge/channels  — Telegram + Discord adapters; inbound message → run
  commands/  @bridge/commands  — one command catalogue for the CLI and chat "/"
  ui/        @bridge/ui        — design tokens, brand assets
docs/architecture/  ADRs
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run api (:4000, hosts the runtime), worker and web (:3000) |
| `pnpm --filter @bridge/desktop dev` | Run the desktop app against local builds |
| `pnpm --filter @bridge/desktop dist` | Build installers into `apps/desktop/release` |
| `pnpm test` | Full test suite (runs against embedded Postgres) |
| `pnpm typecheck` | Strict TypeScript across the workspace |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format |
| `pnpm build` | Production builds |
| `pnpm db:generate` | Generate SQL migration after editing `schema.ts` |
| `pnpm db:migrate` | Apply migrations by hand — the API also does this on boot |
| `pnpm infra:up` / `infra:down` | Optional Postgres + Redis for server-mode dev |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | embedded, under the data directory | `postgres://…` for a server, `pglite:<path>` embedded |
| `BRIDGE_DATA_DIR` | platform app-data directory | Database, agent workspaces, uploads |
| `BRIDGE_WEB_DIR` | unset | Built web client to serve from the API process |
| `REDIS_URL` | unset | Set to use BullMQ for scheduled jobs; unset runs them in-process |
| `BRIDGE_EMBEDDED_RUNTIME` | auto | `1`/`0` to force the run executor in or out of the API process |
| `BRIDGE_SECRET_KEY` | from the OS credential store | Base64 32-byte key encrypting stored credentials. **Required for a production server.** Left unset, Bridge keeps one in the platform credential store (macOS Keychain, libsecret, Windows DPAPI) so a desktop install survives restarts; generate one with `openssl rand -base64 32`. |
| `API_PORT` | `4000` | API port; `0` asks the OS for a free one, which the desktop app does |

## Security notes

Passwords are scrypt-hashed with OWASP parameters; session tokens are stored
only as hashes; provider credentials are encrypted with AES-256-GCM and never
returned by the API (only a masked hint like `sk-…f4a2`). On a desktop the key
that decrypts them lives in the OS credential store, not in a file next to the
data (ADR-0016); where no credential store exists, Bridge falls back to an
owner-only file and says so at startup rather than implying protection it does
not have.

Agent tools run inside a sandbox: filesystem access is confined to the agent's
own directory (resolved through symlinks, so links cannot escape), restricted
network access rejects private and loopback addresses after a DNS lookup, and
shell commands take an argument vector with a minimal environment. Destructive
actions require an explicit permission rule or a human approval — a permissive
default is never enough. Every domain table
is workspace-scoped and cross-tenant access is covered by dedicated tests.
