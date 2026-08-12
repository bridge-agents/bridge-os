# HANDOFF — Bridge Agent OS

**Phases 0–3 are complete. The next phase is Phase 4 — Tools, MCP,
Permissions and Approvals.**

Read in this order before writing code:

1. This file
2. `PRODUCT_SPEC.md` — what Bridge is, the three deployment modes, the MVP
3. `ARCHITECTURE.md` — system design, boundaries, data model
4. `docs/architecture/ADR-0001..0012` — decisions and their reasons
5. `ROADMAP.md` — Phase 4 onward with acceptance criteria

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
  app.ts          buildApp — mounts routes, request logging, error envelope
  index.ts        boot: env → db (+auto-migrate when embedded) → serve
  http.ts         AppDeps/AppEnv types, parseBody, rate limiter
  auth.ts         sessions, requireAuth/requireWorkspace/requireRole, auth routes
  workspaces.ts   workspace CRUD + members
  agents.ts       agent CRUD (validated manifests) + template catalog routes
  providers.ts    provider configuration (credentials via SecretStore)
  runs.ts         deploy/stop, start run, run list, run + trace, cancel, conversations
  architect.ts    natural-language draft/edit with a validation-retry loop
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
packages/db/src/  schema.ts, client.ts (driver selection), events.ts, migrations/
packages/queue/src/  types.ts, bullmq-queue.ts, local-queue.ts
packages/providers/src/
  anthropic.ts       official SDK adapter (no sampling params; refusal mapped through)
  openai-compatible.ts  one adapter for OpenAI / OpenRouter / gateways / Ollama
  pricing.ts         published prices; unknown models return undefined, never a guess
  registry.ts        createProvider() — the only place vendors are chosen
packages/runtime/src/
  compiler.ts        Manifest → RuntimePlan (model roles + tool grants resolved)
  loop.ts            the agent loop; delegation as delegate_to_<name> tools
  executor.ts        claim/heartbeat/reclaim, tracing, cost, conversation persistence
  resolver.ts        workspace provider credentials → adapter (execution time only)
  secrets.ts         SecretStore interface + EncryptedDbSecretStore
docs/architecture/   ADR-0001..0012
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
`run_steps`, `events`. Every domain row carries
`workspace_id`. `agents.manifest` is jsonb and is the source of truth;
`sessions` stores token hashes only; `secrets` stores ciphertext plus a masked
hint. Schema changes: edit `schema.ts` → `pnpm db:generate` → review → commit
both. Embedded installs migrate at boot; servers migrate as a deploy step.

## 7. Current implementation status

Verified 2026-08-12: **172 tests passing**, typecheck 10/10 projects, Biome
clean, web production build, and the full product flow exercised end to end
against a running API **with Docker stopped** — signup → connect a provider →
create an agent → deploy → run → the executor claimed it in-process, called
the provider over real HTTP, and recorded the answer, trace, tokens and
conversation; a second turn replayed history correctly.

Working on top of Phase 2: provider adapters (Anthropic via the official SDK;
one OpenAI-compatible adapter for OpenAI/OpenRouter/gateways/Ollama), the
compiler, the agent loop with subagent delegation, the durable run executor
with heartbeats and crash recovery, deploy/stop gated on connected providers,
runs with full step traces, cancellation, conversations with history replay,
token and cost accounting, and the Agent Architect (draft + natural-language
edit, both returning proposals the user accepts explicitly).

**Not implemented (Phase 4+):** real tool execution and MCP, approval flows,
sandboxing, streaming into the UI, Bridge Chat, the CLI, channels, the
dashboard renderer, and desktop packaging. The loop's tool-dispatch point
consults permissions and records the attempt, then tells the model the tool is
unavailable — Phase 4 fills exactly that seam. `waiting_approval` exists in
the state machine but nothing enters it yet.

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

## 10. Phase 4 instructions (your next phase)

Objective: agents become useful *and* controllable. Full criteria in
`ROADMAP.md`. The seams already exist — fill them rather than restructuring.

1. **Tool registry.** Implement `BridgeTool` (`@bridge/sdk`) instances for the
   native tools the templates already reference (`web-search`, `filesystem`,
   `http`, `shell`). Register them by name so `ToolGrant.kind: "native"`
   resolves. Put the registry in `@bridge/runtime` next to the compiler and
   have `compile()` fail on a grant with no implementation.
2. **Wire the dispatch point.** In `packages/runtime/src/loop.ts`, the branch
   after the `delegate_to_` check currently records the attempt and tells the
   model the tool is unavailable. Replace that with: evaluate the permission,
   `allow` → execute and return the result; `deny` → return the refusal it
   already returns; `ask` → persist a pending approval, set the run to
   `waiting_approval`, and return without finishing the loop.
3. **Approvals.** New table + endpoints (list pending, approve, deny with a
   reason) and an `approval.requested`/`approved`/`denied` event trail. The
   executor resumes a `waiting_approval` run when a decision lands — reuse the
   claim query with that status.
4. **MCP client** (stdio + HTTP) exposed as ordinary `BridgeTool`s through one
   generic adapter, so MCP is not a parallel concept.
5. **Tool execution records** on `run_steps` (`executed: true`, duration,
   result summary) — the trace UI already renders `data` verbatim.
6. **Sandbox foundations** honouring `runtime.sandbox` network/filesystem
   levels for code execution.
7. **Web**: an approvals queue and per-tool grant editing.

Definition of done: an agent with read access cannot write; dangerous actions
pause the run and wait for a human; every tool call is recorded and visible;
and it all still works with no Docker running.

## 11. Remaining roadmap

Phase 4 tools/MCP/permissions/approvals → 5 chat/CLI/channels → 6 dashboards
→ **7 desktop app + local runtime packaging (the consumer installer, keychain
secrets, background operation) + mobile** → 8 automation/always-on → 9
observability → 10 optimizer → 11 Cloud → 12 hardening. Details in
`ROADMAP.md`.

## 12. Unresolved issues / deliberate deferrals

- Event `data` payloads are open records; define per-type payload schemas as
  each emitter lands.
- Streaming: adapters implement `stream()` for text only (no tool-call
  deltas); the loop uses `complete()` and the web client polls. Phase 5 wires
  SSE end to end and will want tool-call streaming then.
- Long-term memory and knowledge are spec-only; only conversation history is
  implemented. `memory.longTerm`/`knowledge` flags are carried but unused.
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
