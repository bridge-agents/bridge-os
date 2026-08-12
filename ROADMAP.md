# Bridge Agent OS — Roadmap

Phase 0 (architecture), Phase 1 (foundation) and Phase 2 (accounts,
workspaces, configuration) are **complete**. Phases 3+ remain. Each phase
lists objective, dependencies, deliverables, acceptance criteria, tests, and
risks.

Ordering is intentional: every phase leaves a runnable, testable system.

A standing requirement for every phase from here on: **nothing may make
Docker, a Postgres server, or a Redis server a prerequisite for a desktop
user** (ADR-0008). New infrastructure goes behind a driver with a
zero-install implementation.

---

## Phase 2 — Accounts, Workspaces and Core Configuration ✅ COMPLETE

**Objective:** Real users, workspaces, agent CRUD, provider configuration and
secret handling on top of the Phase 1 skeleton.

**Delivered**
- Email+password auth (scrypt, OWASP parameters, stdlib only per ADR-0011),
  sessions stored as hashes, cookie *and* bearer paths so the CLI is a
  first-class client from day one. Rate-limited credential endpoints.
- Users, workspaces, membership roles (`owner`/`admin`/`member`), member
  add/remove with last-owner protection. Signup provisions a starter
  workspace (onboarding foundation).
- Agent CRUD persisting validated Manifests as jsonb, re-validated on read;
  create from template, from a raw manifest, or blank; full-manifest replace;
  slug uniqueness per workspace; `agent.*` audit events.
- Template catalog as data (`personal-assistant`, `software-team`,
  `research-agent`) with `instantiateTemplate` and `blankManifest` — one
  validated path for every creation route.
- Provider configuration per workspace with encrypted secret storage behind
  the `SecretStore` interface; hosted providers take keys, local endpoints
  take base URLs; API returns masked hints only.
- Runtime portability correction: embedded-database and in-process-queue
  drivers (ADR-0009/0010), `deployment.target` on the Manifest (ADR-0008).
- Web: auth screens, workspace switcher, template gallery, agent list,
  manifest editor with server-side validation errors, provider management.

**Acceptance criteria — met**
- A user can sign up, create a workspace, connect a provider key (stored
  encrypted), create an agent from a template or blank, edit and save its
  Manifest; invalid manifests are rejected with actionable field-level errors.
- No endpoint returns data across workspace boundaries (16 isolation tests).
- Secret values never appear in logs, API responses, or client bundles.
- The whole flow runs with no Docker and survives a restart.

**Deferred from this phase**
- Email invitations for people without a Bridge account (needs an outbound
  mail path; Cloud).
- API tokens distinct from sessions, and SSO/OAuth (Cloud).
- Key rotation tooling for `BRIDGE_SECRET_KEY` (documented, not automated).

---

## Phase 3 — Agent Architect + Runtime ✅ COMPLETE

**Objective:** First functional agent system: create conversationally, run
real agent loops.

**Delivered**
- `@bridge/providers`: Anthropic adapter (official SDK) and one
  OpenAI-compatible adapter covering OpenAI, OpenRouter, local gateways and
  Ollama. Normalized messages, tool calls, usage and stop reasons — including
  `refusal`, which is a successful response with no usable content. Sampling
  parameters are deliberately not forwarded to Anthropic models that reject
  them. Cost estimation from a published-price table that returns *unknown*
  rather than guessing.
- `@bridge/runtime`: the compiler (Manifest → RuntimePlan, resolving model
  roles and tool grants up front), the agent loop, and the durable executor.
- Agent loop with **subagent delegation** exposed as `delegate_to_<name>`
  tools, bounded by iteration and depth limits, honouring cancellation, run
  deadlines and the permission engine at the tool-dispatch point.
- Run state machine claimed atomically from Postgres with heartbeats,
  stale-run reclamation, bounded retries and per-step tracing (ADR-0012).
- Lifecycle API: deploy (gated on the required providers being connected),
  stop, start a run, list runs, read a run with its full trace, cancel.
- Conversations and message history, replayed into subsequent runs.
- Agent Architect: `draft` from a description and `edit` in natural language,
  both looping on validation errors until the manifest parses, and both
  returning a *proposal* the user accepts through the ordinary agent
  endpoints.
- Per-run token and cost capture, summed across models in a multi-model run.
- Web: deploy/stop, task input, live-polling run list, expandable trace,
  "describe what you want" agent design, and natural-language editing with
  accept/discard.

**Acceptance criteria — met**
- A user creates an agent (template, blank, raw manifest, or AI-designed),
  deploys it, sends a task, and watches it complete with visible run state,
  token usage and cost; stop/deploy and cancellation work.
- Different agents in one manifest can use different providers (compiler
  resolves per-agent `ModelRef`s; the software-team template uses two).
- A worker killed mid-run has its run reclaimed and completed by another.
- Verified end to end against a live API with no Docker running.

**Deferred from this phase**
- Streaming into the UI: adapters implement `stream()` for text, but the loop
  uses `complete()` and the web client polls. Phase 5 wires SSE through.
- Long-term memory and knowledge: `memory.longTerm`/`knowledge` are honoured
  in the spec but only conversation history is implemented.
- Real tools: the loop consults permissions and records the attempt, then
  tells the model the tool is unavailable. Phase 4 registers implementations
  at that exact dispatch point.
- `waiting_approval` exists in the state machine but nothing enters it until
  approvals land in Phase 4.

---

## Phase 4 — Tools, MCP, Permissions and Approvals ← NEXT

**Objective:** Agents become useful *and* controllable.

**Depends on:** Phase 3 (complete). The tool-dispatch point, permission
evaluation and the `waiting_approval` state already exist in the loop —
this phase fills them in rather than restructuring them.

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

## Phase 7 — Desktop App + Local Runtime Packaging (and Mobile)

**Objective:** Deliver the consumer install: `Bridge.dmg`, a Windows
installer and a Linux package that a normal user runs with no infrastructure
knowledge — plus mobile as a control surface.

**Depends on:** Phase 5 (6 for dashboards). The driver work it relies on
(embedded database, in-process queue, secrets interface) landed in Phase 2.

**Deliverables**
- Desktop shell (Tauri preferred — small bundle, no Chromium, and the runtime
  is already pure JS/WASM per ADR-0011) wrapping the web client with native
  menus, notifications and deep links.
- **Local runtime supervision:** the app starts, monitors, restarts and stops
  the api/worker processes; picks a free port; stores data under the platform
  app-data directory; migrates the embedded database on launch and on update.
- **Background operation:** explicit user setting for whether Bridge may run
  in the background; tray/menu-bar presence; honest per-agent status
  (running, paused, stopped, waiting, offline) and a clear statement that
  local agents run only while the device is available. Respect OS limits,
  battery and user settings.
- **Keychain-backed `SecretStore`** implementation (macOS Keychain, Windows
  Credential Manager, libsecret) replacing the encrypted-row store on desktop.
- Installers, code signing/notarisation, and an auto-update channel.
- Mobile via Expo/React Native sharing the API client + design tokens (not
  web DOM code), controlling a runtime on desktop/server/Cloud, with push
  notifications for approvals. No promise of 24/7 on-device execution.

**Acceptance criteria**
- A user with no developer tooling installs Bridge, opens it, and completes
  onboarding → agent → provider → chat without ever seeing Docker, a
  terminal, a port, or a database.
- Closing the window does not stop agents the user configured to run in the
  background; quitting Bridge does, and the UI says so.
- Approve a pending action from a phone notification.

**Tests:** packaged-app smoke test per OS (install → launch → create agent →
run); runtime supervisor restart/crash recovery; keychain store contract
tests against the same `SecretStore` suite; shared API-client suite on all
clients.

**Risks:** per-OS packaging and signing burden (budget real time for it);
background execution policy differences; update + database migration
interaction — test upgrades with existing data, not just clean installs.

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
