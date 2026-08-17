# HANDOFF — Bridge Agent OS

**Phases 0–8 are complete. The next phase is Phase 9 — observability.**

> Read `docs/PHASES_1_7_COMPLETION.md` before using the historical
> "not implemented" and "unresolved" lists below. It records the later
> Phase 1-7 catch-up work, including distinct API tokens, invitations, OIDC,
> durable streaming, knowledge, search, channels, and workspace dashboards.

Read in this order before writing code:

1. This file
2. `PRODUCT_SPEC.md` — what Bridge is, the three deployment modes, the MVP
3. `ARCHITECTURE.md` — system design, boundaries, data model
4. `docs/architecture/ADR-0001..0016` — decisions and their reasons
5. `ROADMAP.md` — Phase 9 onward with acceptance criteria

---

## 1. Product summary

Bridge is an **Agent Operating System and harness generator**: the user
describes the AI system they want; Bridge builds and operates the agentic
infrastructure (agents, subagents, model routing, tools, MCP, memory,
permissions, approvals, schedules, channels, dashboards, observability).

Open core, three deployment targets, one product (ADR-0008):

- **Local desktop (Community)** — the consumer path. Download an installer,
  open the app, get the same polished experience a Cloud user gets. **No
  Docker, no Postgres/Redis install, no terminal, no ports.** The desktop app
  supervises its own local runtime.
- **Self-hosted server (Community)** — developers, homelabs, VPSs, orgs.
  `docker compose up` stays excellent here; it is simply not a consumer
  requirement.
- **Bridge Cloud** — managed runtime and infrastructure.

Manifests are portable across all three. Runtime location ≠ model location.

## 2. Architecture summary

TypeScript modular monolith, pnpm + Turborepo:

- **Control plane** `apps/api` — Hono HTTP API. Routes validate, call domain
  modules, serialize. Auth/workspace middleware is the tenant boundary.
- **Data plane** `@bridge/runtime` — the compiler, agent loop and run
  executor. Runs are durable state machines in Postgres, claimed with
  `FOR UPDATE SKIP LOCKED` and heartbeated (ADR-0012); executors are stateless.
  `apps/worker` hosts it for servers; `apps/api` hosts it in embedded mode,
  because PGlite is single-process.
- **Contracts** `packages/spec` — Zod schemas for the Manifest, dashboards,
  permissions, events, templates. Depends on zod only.
- **Adapters** `packages/sdk` — Provider / Tool / Channel interfaces.
- **Drivers** — `@bridge/db` (server Postgres *or* embedded PGlite),
  `@bridge/queue` (BullMQ/Redis *or* in-process). Same code either way.
- **Core** `packages/core` — ids, `BridgeError`, `loadEnv`, pino logging, and
  crypto (scrypt passwords, AES-256-GCM secrets, token hashing) using stdlib
  only, so desktop packaging never fights native modules.
- **Web** `apps/web` — Vite + React SPA consuming only the public API.

## 3. Repository map

```text
apps/api/src/
  app.ts          buildApp — routes mounted at / and /api, logging, error envelope
  index.ts        boot: paths → key (OS credential store) → db → serve, publishes api.url
  web.ts          serves the built web client with an SPA history fallback
  http.ts         AppDeps/AppEnv types, parseBody, rate limiter
  auth.ts         sessions, requireAuth/requireWorkspace/requireRole, auth routes
  workspaces.ts   workspace CRUD + members
  agents.ts       agent CRUD (validated manifests) + template catalog routes
  providers.ts    provider configuration (credentials via SecretStore)
  runs.ts         deploy/stop, start run, run list, run + trace, cancel, conversations
  approvals.ts    pending queue, approve/deny — requeues the paused run
  architect.ts    natural-language draft/edit with a validation-retry loop
  testing.ts      createTestApp/signUp/as — embedded-Postgres test harness
  *.test.ts       auth, agents, providers, isolation
apps/worker/src/  jobs.ts (dispatch) + index.ts (queue wiring, schedules)
apps/web/src/     api.ts (the only server contact), session.tsx, ui.tsx, routes/
apps/desktop/src/
  main.ts         Electron shell: window, tray, menus, notifications, deep links
  supervisor.ts   starts/health-checks/restarts the API child (no Electron import)
  approvals.ts    polls for pending approvals, announces each one once
  settings.ts     per-device choices (background operation, notifications)
packages/commands/src/
  commands.ts     the catalogue — one definition per command, public API only
  registry.ts     matching, argument parsing, per-surface availability
packages/spec/src/
  manifest.ts     ManifestSchema, SPEC_VERSION, deployment target, parse/migrate
  permissions.ts  policy + evaluatePermission (first match wins)
  events.ts       typed event catalog + envelope
  dashboard.ts    pages → sections → widgets
  templates/      catalog as data + instantiateTemplate + blankManifest
packages/db/src/  schema.ts, client.ts (driver selection), events.ts, migrations/
packages/queue/src/  types.ts, bullmq-queue.ts, local-queue.ts
packages/providers/src/
  anthropic.ts       official SDK adapter (no sampling params; refusal mapped through)
  openai-compatible.ts  one adapter for OpenAI / OpenRouter / gateways / Ollama
  pricing.ts         published prices; unknown models return undefined, never a guess
  registry.ts        createProvider() — the only place vendors are chosen
packages/runtime/src/
  automations.ts     projects manifest triggers into rows, then fires them
  schedule.ts        next-fire arithmetic and loop endings (no database)
  compiler.ts        Manifest → RuntimePlan (model roles + tool grants resolved)
  loop.ts            frame-stack agent loop: tool dispatch, delegation, approval suspend/resume
  executor.ts        claim/heartbeat/reclaim, checkpointing, tracing, cost, conversations
  resolver.ts        workspace provider credentials → adapter (execution time only)
  secrets.ts         SecretStore interface + EncryptedDbSecretStore
  tools/sandbox.ts   path confinement + network policy (the security boundary)
  tools/native.ts    http, filesystem, shell, web-search
  tools/mcp.ts       JSON-RPC client (stdio + HTTP) → Bridge tools
  tools/registry.ts  grants → implementations; assertGrantsSupported
docs/architecture/   ADR-0001..0013
```

## 4. Stack decisions (do not relitigate without a new ADR)

| Decision | ADR |
|---|---|
| TS strict, ESM, Node ≥22; pnpm + Turborepo; Biome | 0001 |
| Contracts as Zod in `@bridge/spec`; versioned Manifest + migrations | 0002 |
| One Postgres dialect; Drizzle; jsonb manifests re-validated on read | 0003 |
| Runs are durable state; queue is dispatch only | 0004 |
| Hono API, `/v1`, `{ error: { code, message, details } }` envelope | 0005 |
| Vite SPA; theming via tokens; Bridge branding fixed | 0006 |
| Providers/tools/channels behind `@bridge/sdk` | 0007 |
| Three deployment targets; Docker never a runtime prerequisite | 0008 |
| Embedded PGlite for local; one schema, one migration set | 0009 |
| `JobQueue` interface: BullMQ or in-process | 0010 |
| `SecretStore` interface; stdlib crypto, no native deps | 0011 |
| Runs claimed from the database, not pushed through the queue | 0012 |
| Agent loop is a serializable frame stack; approvals suspend a run | 0013 |

Zod v4 note: object defaults use `.prefault({})`, not `.default({})`.

## 5. Commands

```bash
pnpm install
pnpm dev              # api :4000, worker, web :3000 — no Docker needed
pnpm test             # everything, against embedded Postgres
pnpm typecheck | lint | build
pnpm db:generate      # after editing schema.ts — always commit the SQL
pnpm infra:up         # optional Postgres+Redis for server-mode development
```

Server mode: `DATABASE_URL=postgres://… REDIS_URL=redis://… pnpm dev` (run
`pnpm db:migrate` first). CI runs both paths.

## 6. Database overview

Tables: `users`, `sessions`, `workspaces`, `workspace_members`, `agents`,
`secrets`, `provider_configs`, `conversations`, `messages`, `runs`,
`run_steps`, `approvals`, `events`. `runs.checkpoint` holds a paused agent
loop's frame stack (ADR-0013). Every domain row carries
`workspace_id`. `agents.manifest` is jsonb and is the source of truth;
`sessions` stores token hashes only; `secrets` stores ciphertext plus a masked
hint. Schema changes: edit `schema.ts` → `pnpm db:generate` → review → commit
both. Embedded installs migrate at boot; servers migrate as a deploy step.

## 7. Current implementation status

Verified 2026-08-12: **220 tests passing**, typecheck 10/10 projects, Biome
clean, web production build, and the full product flow exercised end to end
against a running API **with Docker stopped** — an agent asked to write a
file, the run paused in `waiting_approval`, a human approved through the API,
the run resumed, the tool executed, and the file appeared inside the agent's
sandbox with one ordered trace across the pause.

Working on top of Phase 3: native tools (`http`, `filesystem`, `shell`,
`web-search`) bound to an enforced sandbox, an MCP client over stdio and HTTP,
a tool registry resolving grants at deploy time, the permission engine wired
into every dispatch (with dangerous actions requiring an explicit allow), and
approvals — a run suspends anywhere including inside a subagent, checkpoints
its frame stack, and resumes from the exact call once decided.

Working on top of Phase 4: streaming from the adapters through the loop to an
SSE endpoint, Bridge Chat in the web app, the `bridge` CLI as a first-class
client of the same public API, and `@bridge/channels` — a channel adapter
framework with Telegram (long polling) and Discord (gateway websocket)
implementations, plus the workspace secrets API a channel binding needs.

Working on top of Phase 5: the dashboard builder — a closed data-source
catalogue resolved server-side, a widget registry with a derived layout,
templates as data, and schema-constrained AI generation and editing with a
preview before anything is applied.

Working on top of Phase 6: the desktop app (`apps/desktop`) — an Electron
shell (ADR-0015) supervising the API as a child of its own binary, OS
application-data directories, the master encryption key in the platform
credential store (ADR-0016), and the API serving the built web client so an
install is one process. Mobile was moved out of Phase 7 to Phase 11; the
reason is in `ROADMAP.md`.

Working on top of Phase 7: automation — schedules (cron with real timezones,
and intervals), event triggers, loops that end, and one shared command
catalogue (`@bridge/commands`) that the CLI and the chat box's "/" palette
both run.

**Not implemented (Phase 9+):** deeper observability, a dead-letter surface,
and mobile. Code signing, notarisation and the Windows/Linux artifacts are
configured but not produced — they need credentials and per-OS runners, not
code (`ROADMAP.md` Phase 7). Per-agent credential scoping and container-level
sandbox isolation are deferred with reasons in `ROADMAP.md` Phase 4; the
Phase 5 ceilings (in-process run bus, polled channel replies, Discord session
resume) are listed in `ROADMAP.md` Phase 5.

## 8. Architectural invariants (violating these = redesign, don't)

1. **One spec.** Every path that creates or edits an agent produces a
   Manifest validated by `@bridge/spec`. No parallel representation.
2. **Schema changes ship with migrations.** Breaking Manifest changes bump
   `SPEC_VERSION` and add a migration function; stored manifests must parse.
3. **Workspace scoping.** Every domain table gets `workspace_id`; every query
   filters by it; routes sit behind `requireWorkspace`. Missing membership
   returns `not_found`, never `forbidden` — don't confirm other tenants exist.
4. **API-first.** Clients contain zero domain logic and use only `/v1`
   endpoints. Cookie and bearer auth are equivalent so the CLI is first-class.
   Local desktop installs have no accounts at all: one auto-provisioned owner,
   loopback-only binding, no sign-in (ADR-0014). Server and Cloud authenticate
   normally — do not let local mode leak into them.
5. **Adapters at the edge.** No vendor code outside adapter implementations.
6. **Permissions before execution.** Every tool call goes through
   `evaluatePermission`; `ask` pauses the run and emits `approval.requested`.
7. **Runs are durable state, not resident processes.** Workers stay stateless
   and crash-safe; checkpoints live in Postgres.
8. **Events for everything significant.** `recordEvent` on every meaningful
   action; it is the audit log and the future realtime/automation source.
9. **Community stands alone, and needs no infrastructure.** No core feature
   may require Bridge Cloud, Docker, a Postgres server, or a Redis server.
   New infrastructure goes behind a driver with a zero-install implementation.
10. **Secrets never leave the server.** Plaintext is resolved at execution
    time only; APIs return references and masked hints; nothing secret is
    logged.
11. **Branding.** Users customise tokens (accent/background/appearance),
    never the Bridge logo, name, or design language.

## 9. Security requirements

- Keep the isolation tests (`apps/api/src/isolation.test.ts`) green and extend
  them with every new workspace-scoped resource. They are the regression net
  for the worst class of bug in this product.
- Never log, return, or persist plaintext credentials. Use `SecretStore`.
- Default-deny: permission policy default is `ask`; new tools declare
  dangerous actions; read never implies write.
- `BRIDGE_SECRET_KEY` is required in production (the API refuses to boot
  without it) and warns in development.
- Enforce `runtime.limits` (token/spend budgets) as soon as real runs exist.
  Runaway autonomous spend is a product-killing bug.

## 10. Phase 9 instructions (your next phase)

Objective: observability — run history you can search, traces you can read,
costs you can attribute. Full criteria in `ROADMAP.md`.

What Phase 8 leaves you, which shapes how Phase 9 should be built:

- **The event log now has a sequence** (`events.seq`), added because a
  timestamp cannot be a cursor. Anything that reads the log incrementally —
  a live feed, an export, a search index — should use it rather than
  inventing a second ordering.
- **Automations already report their own health** (status, reason, next run,
  consecutive failures). The gap is a rollup: "is this agent well" across its
  runs, automations and approvals. Build that from the same rows rather than
  a parallel metrics store.
- **Failed runs have no dedicated surface.** An automation disables itself
  after repeated failures and says so, but there is no queue of poisoned work
  to inspect and re-drive. That is the natural home for the dead-letter
  behaviour deferred from Phase 8.
- **`@bridge/commands` is where a new user-facing verb goes.** Adding a
  command there gives it to the CLI and the chat palette at once; adding it
  to only one of them is the thing this package exists to prevent.
- **Cost is already captured per run** and aggregated by the dashboard data
  sources (`packages/spec/src/sources.ts`). Prefer extending that closed
  catalogue over adding ad-hoc endpoints — it is what keeps AI-authored
  dashboards unable to read arbitrary data.

Definition of done for Phase 8 (met, keep it working): an agent with a
schedule in its manifest runs on time in its own timezone, a loop with an
ending stops itself and says why, two runners never double-fire, and the same
commands work from `bridge` and from "/" in the chat box.

## 11. Remaining roadmap

**9 observability (run history, traces, cost attribution, a dead-letter
surface)** → 10 optimizer → 11 Cloud, which now also carries mobile → 12
hardening. Details in `ROADMAP.md`.

## 12. Unresolved issues / deliberate deferrals

- Event `data` payloads are open records; define per-type payload schemas as
  each emitter lands.
- Streaming: text deltas reach the UI, but tool-call arguments are still
  assembled before dispatch (no tool-call deltas), and the run bus is
  in-process — a browser streaming from an API host that is not the worker
  gets steps and status from the database poll, not live deltas. Cross-process
  fan-out wants Redis pub/sub behind the same `RunEvent` interface.
- Channel replies poll the runs table rather than subscribing; outbound sends
  are split to the platform limit but not rate limited; the Discord adapter
  reconnects with a fresh IDENTIFY instead of resuming a session.
- An automated run cannot trigger an event automation, which rules out
  runaway cycles and also rules out chaining automations. Doing both needs a
  provenance or depth model.
- The automation runner polls every 5s and re-reads manifests every 60s, so a
  newly added schedule starts within a minute rather than instantly.
- Long-term memory and knowledge are spec-only; only conversation history is
  implemented. `memory.longTerm`/`knowledge` flags are carried but unused.
- Sandboxing is process-level (path confinement, argument vectors, a minimal
  environment, DNS-checked network policy), not container isolation. Real
  isolation for untrusted code is Phase 12.
- Tools take no workspace credentials yet, so there is nothing to scope
  per-agent; MCP server credentials ride in the grant config.
- A resumed run re-resolves the approved tool by name against the *current*
  manifest. Editing an agent while a run is paused is safe (an unknown tool is
  treated as denied) but the approval was granted against the old plan.
- Model pricing is a hand-maintained snapshot in `@bridge/providers`; unknown
  models record tokens with a null cost rather than a wrong one.
- The architect picks a default model per provider and retries up to three
  times on validation errors; there is no diff UI yet, just current-vs-proposed.
- Run pickup latency is bounded by the executor poll interval (1s).
- Email invitations need an outbound mail path (Cloud); Phase 2 only adds
  existing accounts to a workspace.
- API tokens are currently the same records as sessions; split them when the
  CLI ships if scoping or revocation needs differ.
- `runtime.sandbox` levels are spec-only; enforcement is Phase 4.
- No Dockerfiles for api/worker/web yet (compose covers infra only). Desktop
  packaging is done (`apps/desktop`); the server-image story is not.
- The API test harness always uses embedded Postgres; the server driver is
  covered by `packages/db` tests in the server-mode CI job. If a query ever
  depends on server-only behaviour, add a server-mode API run.
- Rate limiting and the local queue are in-process (marked `ponytail:` in the
  code with their ceilings); both need shared/durable versions only when
  Cloud runs multiple instances.
- `@bridge/ui` holds tokens plus the primitives the web app needed; grow it
  as real screens demand, not preemptively.
- The desktop macOS build is signed with whatever local development identity
  is present and is not notarised, so it warns on another machine. Windows
  and Linux artifacts are configured but have never been built. Both need
  credentials and per-OS CI runners.
- The desktop update feed URL is a placeholder; `electron-updater` is wired
  and treats an unreachable feed as "no update".

## 13. Warnings — do not redesign without a written ADR

- Do not replace the Manifest with per-feature config tables. jsonb + spec
  validation is deliberate (AI editing, versioning, migration, portability).
- **Do not reintroduce a hard dependency on Docker, a Postgres server, or a
  Redis server.** That was corrected once already (ADR-0008/0009/0010); a
  feature that only works with services running is not finished.
- Do not add SQLite or a second dialect "for local" — the embedded driver is
  real Postgres precisely so there is one schema and one migration set.
- Do not add native dependencies (argon2, libsodium, better-sqlite3) to the
  runtime path; desktop packaging depends on staying pure JS/WASM (ADR-0011).
- Do not couple the web app to API internals; extract a typed API client
  package when the CLI arrives.
- Do not swap Biome/Drizzle/Hono/Vite for ecosystem defaults; the ADRs explain
  the choices and churn here buys no user value.
- Do not weaken `@bridge/spec`'s zero-dependency rule or move schemas out of
  it.
- Do not make the agent loop hold state across an approval wait, and do not
  put anything unserializable in a loop frame — durability of a paused run
  depends on the frame stack being plain data (ADR-0013).
- Do not weaken the sandbox checks in `tools/sandbox.ts`: paths are resolved
  through symlinks before the containment check, and restricted network access
  resolves DNS rather than trusting the hostname. Both exist because the
  obvious string-level checks are bypassable.
