# HANDOFF TO OPUS 5 — Bridge Agent OS

You are Opus 5, taking over Bridge Agent OS after Fable 5 completed Phase 0
(architecture + product specification) and Phase 1 (foundation
infrastructure). **Your job starts at Phase 2.** Everything you need to
continue without redesigning the project is in this file and the documents it
links.

Read in this order before writing code:

1. This file
2. `PRODUCT_SPEC.md` — what Bridge is and the MVP definition
3. `ARCHITECTURE.md` — system design, boundaries, data model
4. `docs/architecture/ADR-0001..0007` — decisions and their reasons
5. `ROADMAP.md` — Phases 2–12 with acceptance criteria

---

## 1. Product summary

Bridge is an **Agent Operating System and harness generator**: the user
describes the AI system they want; Bridge builds and operates the agentic
infrastructure (agents, subagents, model routing, tools, MCP, memory,
permissions, approvals, schedules, channels, dashboards, observability).
Open-core: self-hostable Community (`docker compose up`) + managed Cloud
later. Public brand: **Bridge**; formal name: **Bridge Agent OS**. The
attached metallic bridge logo (`packages/ui/assets/bridge-icon.png`) is the
permanent identity; the product is dark, premium, restrained (see
`PRODUCT_SPEC.md` §11).

## 2. Architecture summary

TypeScript modular monolith, pnpm + Turborepo monorepo:

- **Control plane** `apps/api` — Hono HTTP API on Node. Routes are thin;
  domain logic goes in modules under `apps/api/src/` (create `domains/` or
  similar as Phase 2 grows).
- **Data plane** `apps/worker` — BullMQ workers on Redis. Runs are durable
  state machines persisted in Postgres, executed by stateless workers
  (ADR-0004). Queue name: `bridge-runs` (`apps/worker/src/jobs.ts`).
- **Contracts** `packages/spec` (`@bridge/spec`) — Zod schemas for the
  **Bridge Manifest**, dashboard spec, permission policy, typed events, and
  templates. Zod is the single source of truth; TS types are inferred
  (ADR-0002). Depends on zod only — keep it that way.
- **Adapters** `packages/sdk` (`@bridge/sdk`) — Provider / Tool / Channel
  interfaces (ADR-0007) + `MockProvider` for tests.
- **DB** `packages/db` (`@bridge/db`) — Drizzle schema + SQL migrations
  (ADR-0003). `createDb`, `pingDb`, tables, committed migrations.
- **Core** `packages/core` — prefixed ids (`ws_`, `agt_`, `run_`...),
  `BridgeError` (+ HTTP status mapping), `loadEnv` (zod-validated env),
  `createLogger` (pino, structured JSON).
- **UI** `packages/ui` — design tokens (`src/tokens.css`, CSS custom
  properties) + brand asset. `apps/web` is a Vite + React SPA that maps
  tokens into Tailwind v4 (ADR-0006); it talks only to the API (dev proxy
  `/api` → `:4000`).

Dependency rule: `apps/* → @bridge/*`; `@bridge/spec` imports nothing but
zod; nothing imports from `apps/*`.

## 3. Repository map

```text
apps/api/src/app.ts          buildApp(deps) — routes, request logging, error envelope
apps/api/src/index.ts        boot: env → db → serve, graceful shutdown
apps/api/src/app.test.ts     route tests via app.request() (no socket)
apps/worker/src/jobs.ts      RUNS_QUEUE + processJob dispatch (Redis-free, unit-testable)
apps/worker/src/index.ts     BullMQ queue + worker + repeatable heartbeat + shutdown
apps/web/src/App.tsx         shell: logo + live API/db status
packages/spec/src/manifest.ts      ManifestSchema, SPEC_VERSION, parse/migrate
packages/spec/src/permissions.ts   PermissionPolicy + evaluatePermission (first-match)
packages/spec/src/events.ts        EVENT_TYPES catalog + BridgeEvent envelope + createEvent
packages/spec/src/dashboard.ts     DashboardSchema (pages→sections→widgets, 12 widget types)
packages/spec/src/template.ts      TemplateSchema (templates are data)
packages/spec/src/templates/personal-assistant.ts   reference template + shared test fixture
packages/sdk/src/{provider,tool,channel}.ts         adapter contracts
packages/db/src/schema.ts    workspaces, users, workspace_members, agents, runs, events
packages/db/migrations/      committed SQL (0000_quiet_genesis.sql)
docker-compose.yml           postgres:17 + redis:7 for local dev
.github/workflows/ci.yml     lint → typecheck → build → migrate → test (pg+redis services)
```

## 4. Stack decisions (do not relitigate without strong reason)

| Decision | ADR |
|---|---|
| TS strict, ESM, Node ≥22; pnpm + Turborepo; Biome | ADR-0001 |
| Contracts as Zod in `@bridge/spec`; versioned Manifest with migrations | ADR-0002 |
| One PostgreSQL; Drizzle + SQL migrations; manifests as jsonb re-validated on read | ADR-0003 |
| Redis + BullMQ; runs = durable state machines, workers stateless | ADR-0004 |
| Hono API, `/v1` routes, `{ error: { code, message } }` envelope, SSE for realtime | ADR-0005 |
| Web = Vite SPA; theming via tokens only; Bridge branding immutable | ADR-0006 |
| Providers/tools/channels behind `@bridge/sdk`; credentials only at execution time | ADR-0007 |

Zod v4 note: object-with-defaults uses `.prefault({})` (input-side default),
not `.default({})` — follow the existing pattern in `manifest.ts`.

Apps run TypeScript directly via `tsx` (dev **and** start). There is
deliberately no bundling step for api/worker yet; add one when producing
production Docker images (Phase 11), not before.

## 5. Commands

```bash
pnpm install            # workspace install
pnpm infra:up           # docker compose: postgres:5432 (bridge/bridge/bridge), redis:6379
pnpm db:migrate         # apply migrations (drizzle-kit)
pnpm db:generate        # generate SQL from schema.ts changes — always commit the SQL
pnpm dev                # api :4000, worker, web :3000
pnpm test | typecheck | lint | lint:fix | build
```

Env: copy `.env.example` → `.env`. `loadEnv` fails fast on bad config. The
db integration test skips without `DATABASE_URL`; CI provides services and
runs it.

## 6. Database overview

All domain tables carry `workspace_id` (FK, cascade). `agents.manifest` is
jsonb and is **the** agent source of truth; `spec_version`, `slug`, `status`
are indexed projections. `runs` carries the status enum (`queued | running |
waiting_approval | succeeded | failed | cancelled`), trigger, tokens,
`cost_usd`, timing. `events` is the append-only audit log matching
`@bridge/spec` event types. Schema changes: edit `schema.ts` →
`pnpm db:generate` → review SQL → commit both.

## 7. Current implementation status (what actually exists)

Working and verified (2026-08-12, all local + CI-configured):

- Install, typecheck (7/7 projects), Biome lint, web production build.
- 39 tests passing: manifest validation incl. cross-reference checks,
  permission evaluation matrix, event envelope, dashboard navigation refs,
  template-as-data, ids/errors/env, MockProvider contract, tool-permission
  flow, API routes, worker job dispatch, **db round-trip against live
  Postgres** (manifest survives jsonb → still validates).
- Migration `0000_quiet_genesis.sql` generated and applied to the compose
  Postgres.
- API boots: `/health` (db up/down/unconfigured), `/v1/meta`,
  `/v1/manifests/validate` (returns normalized manifest or structured
  issues), 404/error envelopes, request-id logging.
- Worker boots: connects Redis, upserts a repeatable 60s heartbeat job,
  processes it, graceful shutdown.
- Web boots: Bridge-branded shell polling `/api/health` through the dev
  proxy; favicon + logo from `@bridge/ui`.

**Not implemented (yours):** auth, secrets, agent CRUD persistence, the
Architect, the run state machine, tools/MCP, approvals, chat, CLI, channels,
dashboard renderer. The `heartbeat` job and the web status page are
placeholders you will replace/extend.

## 8. Architectural invariants (violating these = redesign, don't)

1. **One spec.** Every path that creates or edits an agent produces a
   Manifest validated by `@bridge/spec`. No parallel representation, ever.
2. **Schema changes ship with migrations.** Breaking Manifest changes bump
   `SPEC_VERSION` and add an entry to `migrations` in `manifest.ts`; stored
   manifests must always parse.
3. **Workspace scoping.** Every new domain table gets `workspace_id`; every
   query filters by it. Add cross-tenant-isolation tests as features land.
4. **API-first.** Clients (web, CLI, channels) contain zero domain logic and
   use only public `/v1` endpoints. If the web app needs it, the CLI gets it
   for free.
5. **Adapters at the edge.** No provider/channel/tool vendor code outside
   adapter implementations. The runtime resolves `ModelRef` → registered
   Provider at execution time.
6. **Permissions before execution.** Every tool call goes through
   `evaluatePermission`; `ask` pauses the run (`waiting_approval`) and emits
   `approval.requested`. Tools receive `checkPermission` via context and
   cannot bypass it.
7. **Runs are durable state, not resident processes.** Workers must stay
   stateless and crash-safe; checkpoints live in Postgres.
8. **Events for everything significant.** Emit typed events (append to
   `events` table) for the catalog in `events.ts`; they are the audit log
   and the future realtime/automation source.
9. **Community stands alone.** No feature in core may require Bridge Cloud.
   Cloud-only capability goes behind an interface (secrets driver, sandbox
   driver, auth driver).
10. **Branding.** Users customise tokens (accent/background/appearance),
    never the Bridge logo, name, or design language.

## 9. Security requirements (Phase 2+ must respect)

- Secrets: ciphertext-only at rest (AEAD, key from `BRIDGE_SECRET_KEY` env;
  KMS driver later in Cloud). API returns references, never values. No
  secret in logs, events, manifests, or client bundles — grep-test it.
- Provider credentials reach adapters only at execution time via the
  secrets abstraction.
- Passwords: argon2id. Sessions: httpOnly cookies (web) + bearer tokens
  (CLI). Rate-limit auth endpoints.
- Default-deny posture: permission policy default is `ask`; new tools
  declare `dangerous` actions; read never implies write.
- Keep `runtime.limits` (spend/token budgets) enforced as soon as real runs
  exist — runaway autonomous spend is a product-killing bug.

## 10. Phase 2 instructions (your first phase) — detail

Objective: users, workspaces, agent CRUD, providers, secrets. Full criteria
in `ROADMAP.md` Phase 2. Suggested order:

1. **Migrations**: `sessions`/`api_tokens`, `secrets` (workspace-scoped,
   name + ciphertext + nonce), `provider_configs` (workspace, provider id,
   secret ref, base URL for OpenAI-compatible endpoints), invitations.
   Extend `users` with `password_hash`. Use `@bridge/core` id prefixes
   (`sec_`, `tok_`, `inv_`...).
2. **Auth module** in `apps/api`: signup/login/logout/session; middleware
   sets `{ userId, workspaceId, role }` context; every `/v1` route below
   requires it. Keep an `AuthDriver` interface so Cloud can swap.
3. **Workspace + membership endpoints** (create, invite, roles
   owner/admin/member).
4. **Secrets service**: encrypt/decrypt with `BRIDGE_SECRET_KEY`
   (`crypto.subtle` or libsodium AEAD), redaction helper for logger,
   round-trip + leak tests.
5. **Provider config endpoints**: connect provider → store key as secret,
   validate with a cheap adapter call when possible.
6. **Agent CRUD**: create from template (`@bridge/spec` templates; add 2–3
   more templates as data) or from a raw Manifest; persist normalized
   manifest jsonb; update = full-manifest replace with validation; list/get
   scoped to workspace. Reject invalid manifests with the structured issues
   shape already used by `/v1/manifests/validate`.
7. **Web**: minimal auth screens + workspace switcher + agent list/detail
   (manifest JSON view is fine this phase). Keep domain logic server-side.
8. **Tests**: auth flow, cross-tenant isolation (user A cannot read B's
   agents/secrets — write these first), secret round-trip + never-in-logs,
   manifest persistence/migration, template instantiation.

Definition of done: the ROADMAP Phase 2 acceptance criteria, all CI checks
green, no invariant above violated.

## 11. Remaining roadmap after Phase 2

Phase 3 Architect + runtime → Phase 4 tools/MCP/permissions/approvals →
Phase 5 chat/CLI/channels → Phase 6 dashboards → Phase 7 desktop/mobile →
Phase 8 automation/always-on → Phase 9 observability → Phase 10 optimizer →
Phase 11 Cloud → Phase 12 hardening. Objectives, dependencies, deliverables,
acceptance criteria, tests, and risks for each are in `ROADMAP.md`.

## 12. Unresolved issues / deliberate deferrals

- Event `data` payloads are open records; define per-type payload schemas in
  `events.ts` as each emitter lands (don't speculate ahead of use).
- Template instantiation/merge logic doesn't exist yet (templates validate
  as data; Phase 2 adds instantiate → customise).
- `runtime.sandbox` levels are spec-only; enforcement is Phase 4.
- Heartbeat scheduler is a placeholder proving BullMQ repeatables; replace
  with Manifest-driven schedules in Phase 8.
- No Dockerfiles for api/worker/web yet (compose covers infra only); the
  full-stack `docker compose up` product experience is a later deliverable —
  keep it possible (it currently is), don't build it early.
- `@bridge/ui` has no components yet, only tokens; add components when the
  first real screens need them (Phase 2 web work).
- Node 25 warns that `--experimental-loader` style usage by tsx is fine;
  engines pin is `>=22`. CI runs Node 22.

## 13. Warnings — things NOT to redesign without a written ADR

- Do not replace the Manifest with per-feature config tables. jsonb +
  spec validation is deliberate (AI editing + versioning + migration).
- Do not introduce microservices, Kubernetes, Temporal, or a message broker
  beyond Redis/BullMQ at this stage (ADR-0001/0004 explain the exit paths).
- Do not couple the web app to the API internals (no shared server code —
  only the public HTTP contract; extract a typed API client package when
  the CLI arrives).
- Do not swap Biome/Drizzle/Hono/Vite for ecosystem-default alternatives
  (ESLint+Prettier/Prisma/Express/Next) — the ADRs document why these were
  chosen for this product; churn here burns the schedule for zero user value.
- Do not weaken `@bridge/spec`'s zero-dependency rule or move schemas out of
  it. Everything depends on it; it depends on nothing.
- If you genuinely must deviate: write `docs/architecture/ADR-000N-*.md`
  explaining why, and keep the invariants in §8 intact.
