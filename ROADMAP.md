# Bridge Agent OS — Roadmap

Phase 0 (architecture) and Phase 1 (foundation) are **complete** — built by
Fable 5. Phases 2+ are implemented by Opus 5. Each phase lists objective,
dependencies, deliverables, acceptance criteria, tests, and risks.

Ordering is intentional: every phase leaves a runnable, testable system.

---

## Phase 2 — Accounts, Workspaces and Core Configuration

**Objective:** Real users, workspaces, agent CRUD, provider configuration and
secret handling on top of the Phase 1 skeleton.

**Depends on:** Phase 1.

**Deliverables**
- Authentication (email+password with argon2, session cookies; API tokens for
  CLI later). Keep an interface that Cloud can swap for managed auth.
- Users, workspaces, membership roles (`owner`, `admin`, `member`) — tables
  exist; add auth glue + invitation flow.
- Workspace settings; agent CRUD persisting validated Manifests (jsonb).
- Template system: templates as data (`@bridge/spec` `TemplateSchema`),
  seeded catalog, instantiate → Manifest.
- Provider configuration per workspace + encrypted secrets storage
  (libsodium/`crypto` AEAD; key from env `BRIDGE_SECRET_KEY`). Secrets table
  stores ciphertext only; API returns references, never values.
- Permission defaults per workspace; onboarding flow skeleton in web.

**Acceptance criteria**
- A user can sign up, create a workspace, connect a provider key (stored
  encrypted), create an agent from a template or blank, edit and save its
  Manifest; invalid manifests are rejected with actionable errors.
- No endpoint returns data across workspace boundaries (tested).
- Secret values never appear in logs, API responses, or client bundles.

**Tests:** auth flows, workspace isolation (attempt cross-tenant reads),
secret round-trip + redaction, manifest persistence/migration, template
instantiation.

**Risks:** auth scope creep (defer SSO/OAuth to Cloud); secret key
management ergonomics for self-hosters (document key rotation).

---

## Phase 3 — Agent Architect + Runtime

**Objective:** First functional agent system: create conversationally, run
real agent loops through the queue.

**Depends on:** Phase 2.

**Deliverables**
- Anthropic + OpenAI + OpenAI-compatible provider adapters implementing
  `@bridge/sdk` Provider (streaming + usage capture).
- Agent Architect: conversational creation/customisation that emits Manifest
  edits (template → tweak, and blank → propose); user inspects diff before
  apply. Uses structured output against `@bridge/spec`.
- Harness compiler: Manifest → runtime plan (resolved models per agent,
  tool grants, limits) with validation errors surfaced.
- Core runtime in worker: run state machine (`queued → running →
  waiting_approval → succeeded/failed/cancelled`), checkpoints in Postgres,
  cancellation, retries with backoff, timeouts from `runtime.limits`.
- Agent/subagent delegation per `canDelegateTo`; conversation history +
  working memory (Postgres-backed, interfaces from ARCHITECTURE §9).
- Runtime lifecycle API: deploy/start/stop/restart agent; run history.
- Token/cost capture per run from provider usage.

**Acceptance criteria**
- User creates an agent from template or scratch, customises it in natural
  language, deploys it, sends it a task, watches it complete with visible
  run states; stop/restart works; a killed worker resumes queued runs.
- Different agents in one manifest can use different providers.

**Tests:** state machine transitions (unit), resumability (kill worker
mid-run in integration test), provider adapter contract tests against
`MockProvider` + recorded fixtures, compiler golden tests (manifest →
runtime plan), cost accounting.

**Risks:** runtime loop complexity — keep the loop small and push variation
into data; architect quality — constrain with schemas + validation retries.

---

## Phase 4 — Tools, MCP, Permissions and Approvals

**Objective:** Agents become useful *and* controllable.

**Depends on:** Phase 3.

**Deliverables**
- Tool registry (native tools: HTTP, filesystem-scoped, search, code exec
  stub) + MCP client support (stdio + HTTP transports) mapped to the Tool
  interface.
- Permission engine wired into every tool call (`evaluatePermission`);
  scoped tool access from Manifest grants.
- Human approval flow: `ask` → run pauses, `approval.requested` event,
  approval UI in web (approve/deny with context), run resumes.
- Tool execution records (input/output/duration/status) on runs.
- Sandbox foundations: code execution in a container with network/filesystem
  levels from `runtime.sandbox`.
- Secrets permissions: which agents may use which credentials.

**Acceptance criteria**
- An agent with Gmail-read cannot send Gmail; dangerous actions prompt for
  approval; denials are logged; every tool call is recorded and visible.
- An MCP server can be added by URL/command and its tools granted per agent.

**Tests:** permission matrix table tests, approval pause/resume integration,
MCP handshake against a fixture server, sandbox escape smoke tests
(network/filesystem boundaries).

**Risks:** sandbox depth — start with container + level flags, harden in
Phase 12; MCP server variance — pin to spec version, tolerate partial
implementations.

---

## Phase 5 — Chat, Terminal and Channels

**Objective:** Bridge Chat, Bridge CLI, and the channel framework.

**Depends on:** Phase 3 (4 for approval cards).

**Deliverables**
- Bridge Chat (web): conversations, streaming messages (SSE), files, agent
  selection/switching, tool activity, task state, approval cards, run status.
- Bridge CLI (`apps/cli`): `bridge chat`, `bridge agent list|run`, `bridge
  status`, `bridge logs`, `bridge task list` against the public API with
  token auth. First-class client, no private endpoints.
- Channel framework: `@bridge/sdk` Channel implementations for Telegram and
  Discord; inbound → runtime tasks, outbound ← typed events. Architecture
  ready for iMessage/Slack.

**Acceptance criteria**
- Full agent interaction from web chat and CLI without touching internals;
  a Telegram user can converse with a deployed agent; channel code contains
  zero runtime logic (only adapter calls).

**Tests:** SSE streaming integration, CLI e2e against local API, channel
adapter contract tests with fake transports.

**Risks:** streaming edge cases (reconnect/resume — use run checkpoints);
channel rate limits (queue outbound sends).

---

## Phase 6 — Dashboard Builder

**Objective:** Render, template, and AI-edit dashboards from the schema.

**Depends on:** Phase 5.

**Deliverables**
- Dashboard renderer (widget registry → React components) bound to API data
  sources; layout engine; navigation.
- Dashboard templates (Business, Personal, School, Fitness) as data; blank
  dashboards; per-agent attach.
- Theme tokens: accent/background/appearance customisation only; Bridge
  branding fixed.
- AI dashboard generation and natural-language editing (schema-constrained
  edits with validation + preview before apply).

**Acceptance criteria**
- User picks none/template/scratch; "Put my agent costs at the top" produces
  a valid schema diff and safe re-render; invalid AI edits are rejected, not
  rendered.

**Tests:** schema round-trip (generate → validate → render snapshot), widget
data-binding tests, AI edit property tests (output always validates).

**Risks:** widget sprawl — ship the 12 core widgets, resist bespoke ones;
data-binding performance (paginate/aggregate server-side).

---

## Phase 7 — Desktop + Mobile

**Objective:** Polished native-feeling clients focused on Chat, agents,
tasks, approvals, notifications, dashboards, status.

**Depends on:** Phase 5 (6 for dashboards).

**Deliverables:** Desktop via Tauri wrapping the web client with native menus,
notifications, and deep links; Mobile via Expo/React Native sharing the API
client + design tokens (not web DOM code); push notifications for approvals.

**Acceptance criteria:** approve a pending action from a phone notification;
desktop app passes platform notification/system-tray basics.

**Tests:** shared API-client test suite runs on all clients; notification
delivery integration.

**Risks:** duplicated UI logic — keep domain logic in API + shared client
package; store review cycles (mobile later in phase).

---

## Phase 8 — Automation, Scheduling and Autonomous Operation

**Objective:** Always-running Agent OS: schedules, triggers, resumability,
health.

**Depends on:** Phase 3 (approvals from 4).

**Deliverables:** cron schedules (BullMQ repeatables) from Manifest triggers;
event automations (event → agent task); long-running jobs with checkpoints;
retry policies per agent; watchdogs + agent health status; failure recovery
(dead-letter queue + operator surface).

**Acceptance criteria:** "Run the research agent every weekday morning"
works from natural language → Manifest trigger → execution; a crashed worker
mid-job resumes without duplicate side effects (idempotency keys); users see
agent health.

**Tests:** schedule drift/timezone tests, chaos test (kill workers under
load), duplicate-delivery idempotency, DLQ replay.

**Risks:** runaway automations — spend/токen limits enforced here at the
latest; timezone correctness (store TZ per schedule).

---

## Phase 9 — Observability

**Objective:** Users understand exactly what their autonomous system does.

**Depends on:** Phases 3–8 emit events/usage already; this phase surfaces it.

**Deliverables:** runs/traces/task history UI; per-agent activity; tool call
inspection; token + provider usage and estimated cost per run/agent/
workspace; failures + retries + latency views; approval history; runtime
health dashboard.

**Acceptance criteria:** for any run, a user can answer "what did it do, what
did it call, what did it cost, why did it fail" in ≤3 clicks.

**Tests:** cost calculation golden tests per provider pricing table; trace
completeness (every tool call in a run appears exactly once).

**Risks:** event volume — partition/prune `events`; pricing drift — pricing
tables as data with versioning.

---

## Phase 10 — Bridge Optimizer (later)

**Objective:** Bridge evaluates its own agent architectures.

**Depends on:** Phase 9 (needs usage/trace data).

**Deliverables:** detectors (expensive model on trivial role, excessive
context, repeated failures, redundant tool calls, slow workflows); proposal
engine ("this change reduces cost, keeps performance") producing Manifest
diffs for user approval; evaluation harness before/after; opt-in automatic
A/B of architectures with guardrails.

**Acceptance criteria:** proposals are diffs the user approves — the
optimizer can never rewrite production without explicit consent + rollback.

**Tests:** detector precision on fixture traces; proposal diffs always
validate; rollback integrity.

**Risks:** silent quality regressions — require eval runs before apply.

---

## Phase 11 — Bridge Cloud (later)

**Objective:** Managed Bridge, same core.

**Deliverables:** hosted runtime, managed Postgres/queues, KMS-backed
secrets, sandbox infra, backups, org/teams auth, managed deployment, usage
limits + metering + billing, monitoring, update channel, cloud↔local
connection.

**Acceptance criteria:** a Community manifest deploys unchanged to Cloud;
Community remains fully functional standalone.

**Risks:** core/cloud drift — Cloud only implements interfaces that already
exist in core (secrets driver, sandbox driver, auth driver).

---

## Phase 12 — Production Hardening (pre-broad-release)

Security review, sandbox hardening, permission review, tenant isolation
tests, secret leakage tests, load/failure/migration/backup/recovery testing,
desktop/mobile testing, accessibility, performance, documentation, upgrade
paths, telemetry/privacy review.

**Acceptance criteria:** external security review passes; restore-from-backup
drill documented and rehearsed; p95 API latency and run-start latency targets
set and met.
