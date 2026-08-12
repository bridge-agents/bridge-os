# HANDOFF — Bridge Agent OS

**Phases 0, 1 and 2 are complete. The next phase is Phase 3 — Agent Architect
+ Runtime.**

Read in this order before writing code:

1. This file
2. `PRODUCT_SPEC.md` — what Bridge is, the three deployment modes, the MVP
3. `ARCHITECTURE.md` — system design, boundaries, data model
4. `docs/architecture/ADR-0001..0011` — decisions and their reasons
5. `ROADMAP.md` — Phase 3 onward with acceptance criteria

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
- **Data plane** `apps/worker` — job processing via `@bridge/queue`. Runs are
  durable state machines in Postgres; workers are stateless.
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
  app.ts          buildApp — mounts routes, request logging, error envelope
  index.ts        boot: env → db (+auto-migrate when embedded) → serve
  http.ts         AppDeps/AppEnv types, parseBody, rate limiter
  auth.ts         sessions, requireAuth/requireWorkspace/requireRole, auth routes
  workspaces.ts   workspace CRUD + members
  agents.ts       agent CRUD (validated manifests) + template catalog routes
  providers.ts    provider configuration (credentials via SecretStore)
  secrets.ts      SecretStore interface + EncryptedDbSecretStore
  events.ts       recordEvent — appends to the audit log
  testing.ts      createTestApp/signUp/as — embedded-Postgres test harness
  *.test.ts       auth, agents, providers, isolation
apps/worker/src/  jobs.ts (dispatch) + index.ts (queue wiring, schedules)
apps/web/src/     api.ts (the only server contact), session.tsx, ui.tsx, routes/
packages/spec/src/
  manifest.ts     ManifestSchema, SPEC_VERSION, deployment target, parse/migrate
  permissions.ts  policy + evaluatePermission (first match wins)
  events.ts       typed event catalog + envelope
  dashboard.ts    pages → sections → widgets
  templates/      catalog as data + instantiateTemplate + blankManifest
packages/db/src/  schema.ts, client.ts (driver selection), migrations/
packages/queue/src/  types.ts, bullmq-queue.ts, local-queue.ts
docs/architecture/   ADR-0001..0011
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
`secrets`, `provider_configs`, `runs`, `events`. Every domain row carries
`workspace_id`. `agents.manifest` is jsonb and is the source of truth;
`sessions` stores token hashes only; `secrets` stores ciphertext plus a masked
hint. Schema changes: edit `schema.ts` → `pnpm db:generate` → review → commit
both. Embedded installs migrate at boot; servers migrate as a deploy step.

## 7. Current implementation status

Verified 2026-08-12: **117 tests passing**, typecheck 8/8 projects, Biome
clean, web production build, and the full product flow exercised end to end
against a running API **with Docker stopped**: signup → workspace → connect
provider (encrypted, masked in responses) → create agent from template →
invalid manifests rejected with field-level issues → restart → data, sessions
and agents all still there.

Working: auth (cookie + bearer, rate limited), workspaces and members, agent
CRUD from template/manifest/blank with validation on read and write, template
catalog, provider configuration with encrypted credentials, audit events,
both database drivers, both queue drivers, and a web client covering all of
it.

**Not implemented (Phase 3+):** provider adapters (only `MockProvider`
exists), the Agent Architect, the run state machine and agent loop, tools/MCP,
approvals, chat, CLI, channels, dashboard renderer, desktop packaging. The
worker's `heartbeat` job is a placeholder proving scheduling on both drivers.

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

## 10. Phase 3 instructions (your next phase)

Objective: the first functional agent system. Full criteria in `ROADMAP.md`.
Suggested order:

1. **Provider adapters** implementing `@bridge/sdk` `Provider`: Anthropic,
   OpenAI, and an OpenAI-compatible adapter that covers Ollama/local
   endpoints via `provider_configs.baseUrl`. Streaming + usage capture.
   Resolve credentials through `SecretStore` at execution time only. Write
   one contract test suite and run every adapter through it.
2. **Migrations** for `conversations`, `messages`, `run_steps`, and working
   memory. Keep `runs` as the state machine record.
3. **Compiler**: Manifest → runtime plan (resolve model roles per agent, tool
   grants, limits). Golden tests, and surface validation errors the same way
   agent routes already do.
4. **Runtime loop** in the worker: `queued → running → waiting_approval →
   succeeded | failed | cancelled`, checkpointed in Postgres, with retries,
   timeouts from `runtime.limits`, cancellation, and subagent delegation per
   `canDelegateTo`. Emit `run.*`/`task.*` events. Enqueue via `@bridge/queue`
   so it works on both drivers — test it with Docker stopped.
5. **Agent Architect**: conversational create/customise that emits Manifest
   diffs for user approval, constrained by the Zod schema with validation
   retries. It edits the same manifests the API already stores.
6. **Lifecycle API**: deploy/start/stop/restart, run history, per-run token
   and cost capture from provider usage.

Definition of done: a user creates an agent, deploys it, sends a task,
watches it run to completion, and stops it — on a laptop with no Docker.

## 11. Remaining roadmap

Phase 3 Architect + runtime → 4 tools/MCP/permissions/approvals → 5
chat/CLI/channels → 6 dashboards → **7 desktop app + local runtime packaging
(the consumer installer, keychain secrets, background operation) + mobile** →
8 automation/always-on → 9 observability → 10 optimizer → 11 Cloud → 12
hardening. Details in `ROADMAP.md`.

## 12. Unresolved issues / deliberate deferrals

- Event `data` payloads are open records; define per-type payload schemas as
  each emitter lands.
- Email invitations need an outbound mail path (Cloud); Phase 2 only adds
  existing accounts to a workspace.
- API tokens are currently the same records as sessions; split them when the
  CLI ships if scoping or revocation needs differ.
- `runtime.sandbox` levels are spec-only; enforcement is Phase 4.
- No Dockerfiles for api/worker/web yet (compose covers infra only). Desktop
  packaging is Phase 7.
- The API test harness always uses embedded Postgres; the server driver is
  covered by `packages/db` tests in the server-mode CI job. If a query ever
  depends on server-only behaviour, add a server-mode API run.
- Rate limiting and the local queue are in-process (marked `ponytail:` in the
  code with their ceilings); both need shared/durable versions only when
  Cloud runs multiple instances.
- `@bridge/ui` holds tokens plus the primitives the web app needed; grow it
  as real screens demand, not preemptively.
- Production SPA hosting needs a history fallback so client routes deep-link
  correctly; the Vite dev server already handles it.

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
