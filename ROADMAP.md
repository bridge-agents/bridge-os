# Bridge Agent OS — Roadmap

Phases 0–6 are **complete**: architecture, foundation, accounts, the agent
runtime, tools/permissions/approvals, chat/CLI/channels, and dashboards.
Phase 7 is next. Each phase lists
objective, dependencies, deliverables, acceptance criteria, tests, and risks.

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
  uses `complete()` and the web client polls. Phase 5 wired SSE through.
- Long-term memory and knowledge: `memory.longTerm`/`knowledge` are honoured
  in the spec but only conversation history is implemented.
- Real tools: the loop consults permissions and records the attempt, then
  tells the model the tool is unavailable. Phase 4 registers implementations
  at that exact dispatch point.
- `waiting_approval` exists in the state machine but nothing enters it until
  approvals land in Phase 4.

---

## Phase 4 — Tools, MCP, Permissions and Approvals ✅ COMPLETE

**Objective:** Agents become useful *and* controllable.

**Delivered**
- **Native tools** bound to a per-agent sandbox: `http`, `filesystem`,
  `shell`, `web-search`. Each declares its actions and which of them are
  destructive, and classifies an input into an action *before* execution so a
  decision can be made without side effects.
- **Sandbox enforcement** for `runtime.sandbox` (ADR-0008 levels): filesystem
  access is confined by resolving symlinks before the check (so a link cannot
  be used as a way out), and `restricted` network access resolves DNS and
  rejects private, loopback and link-local addresses — which blocks the cloud
  metadata endpoint and SSRF through a public-looking hostname. Redirects are
  not followed. `shell` uses an argument vector, never a shell string.
- **MCP client** over stdio and HTTP (JSON-RPC 2.0), exposing each remote tool
  as an ordinary Bridge tool named `<grant>.<tool>` so MCP flows through the
  same permissions, approvals and tracing as everything else.
- **Tool registry** resolving manifest grants to implementations, with
  `assertGrantsSupported` failing at deploy time rather than mid-run.
- **Permission engine wired into every call.** `decideToolPermission`
  downgrades a destructive action to `ask` when only a permissive *default*
  would have allowed it — allowing something dangerous has to be deliberate.
- **Approvals**: the loop became a serializable frame stack (ADR-0013), so a
  run suspends — anywhere, including inside a subagent — writes its stack to
  `runs.checkpoint`, and releases the worker. Deciding requeues the run and an
  executor resumes from the exact call that was waiting. Denials carry a
  reason back to the model.
- **Tool execution records** on `run_steps`: tool, action, arguments, effect,
  whether it executed, duration, and result or error.
- Approvals API (list, approve, deny with reason) with `approval.*` events,
  and a web approvals queue showing exactly what would run, with a pending
  badge in the shell.

**Acceptance criteria — met**
- An agent with read access cannot write: a policy granting `read`/`list`
  denies a `write` outright, and no human is asked.
- Dangerous actions pause the run and wait for a human; nothing executes until
  someone decides.
- Every tool call is recorded and visible in the run trace.
- Verified end to end against a live API with no Docker: an agent paused, a
  human approved, the run resumed, and the file was actually written inside
  the agent's sandbox.

**Deferred from this phase**
- Per-agent credential scoping ("which agents may use which secrets"). Tools
  do not take workspace credentials yet — provider keys are resolved per
  workspace at execution time — so there is nothing to scope until a tool
  needs one. MCP server credentials ride in the grant config.
- Container-level sandboxing for code execution. The current boundaries are
  process-level (path confinement, argument vectors, a minimal environment,
  network policy), which is meaningful but not isolation; hardening is Phase 12.
- Approval expiry/timeouts and notification delivery (Phase 7 brings push).
- `web-search` needs a configured search endpoint; unconfigured it returns an
  actionable error rather than pretending to search.

---

## Phase 5 — Chat, Terminal and Channels ✅ COMPLETE

**Objective:** Bridge Chat, Bridge CLI, and the channel framework.

**Delivered**
- Streaming end to end: `Provider.streamComplete()` on the Anthropic and
  OpenAI-compatible adapters, deltas through the agent loop, and
  `GET /v1/workspaces/:id/runs/:runId/stream` (SSE) carrying deltas, run
  steps and status. The endpoint reads deltas from an in-process bus *and*
  polls `run_steps`, so it is correct with a separate worker and live in
  embedded mode.
- Bridge Chat (web): agent selection, streamed answers, tool activity from
  `run_steps`, approval cards that resume the paused run in place, and
  conversation replay via `?agent=&conversation=`.
- Bridge CLI (`apps/cli`): `login`, `status`, `agent list|run`, `chat`,
  `runs`, `logs`, `approvals`, `approve`, `deny` — all against the public
  API with token auth, config in `~/.bridge/config.json` (mode 0600).
- Channel framework (`@bridge/channels`): `ChannelRunner` maps an inbound
  message to a conversation (`conversations.external_id`) and an ordinary
  run with trigger `channel`; `ChannelManager` starts bindings for deployed
  agents and stops them when an agent is undeployed. Telegram (long polling,
  works behind NAT) and Discord (gateway websocket, no dependency) adapters.
- Workspace secrets API and UI, so a channel binding names a token
  (`config.tokenSecret`) instead of embedding one in a portable manifest.

**Acceptance criteria — met**
- Web chat and CLI drive an agent end to end through public endpoints only.
- A channel user converses with a deployed agent; the channel packages
  contain no runtime logic, only adapter calls and one enqueue.

**Tests:** 247 across the workspace — SSE streaming integration, CLI routed
through the real Hono app, channel runner/manager/Telegram against fakes.

**Known ceilings:** the run bus is in-process (cross-process streaming needs
Redis pub/sub); channel replies poll the runs table; the Discord adapter
re-identifies rather than resuming a session; outbound sends are not rate
limited beyond message splitting.

---

## Phase 6 — Dashboard Builder ✅ COMPLETE

**Objective:** Render, template, and AI-edit dashboards from the schema.

**Delivered**
- **A closed data-source catalogue** (`packages/spec/src/sources.ts`): 14
  named sources in three shapes — metric, series, rows. Widget `source` is a
  free string in the schema, so without a catalogue a dashboard would decide
  what data to read; naming them makes the set auditable, gives the AI a
  vocabulary it cannot exceed, and makes an unknown name render as a labelled
  gap instead of an error.
- **Server-side resolution** (`GET /v1/workspaces/:id/data/:source`).
  Aggregation happens in SQL — "spend per day" never means shipping every run
  to the browser. Every query is workspace-scoped.
- **Renderer**: widget registry → React components, with a derived layout
  (documents say *what*, never pixel coordinates, which is what makes AI
  edits safe — there are no positions to corrupt). Charts are ~120 lines of
  SVG rather than a charting dependency to ship on three desktop platforms.
- **Templates as data** (Overview, Spend, Operations, Activity) plus blank,
  validated by the same schema as anything hand- or AI-written, and asserted
  to bind only to sources that exist so no template ships a dead panel.
- **AI generation and natural-language editing**, schema-constrained: the
  retry loop feeds validation errors back and gives up rather than returning
  something invalid. Proposals render as a live preview and are saved by
  PUTting the manifest through the ordinary agent endpoint, so an AI edit
  passes exactly the validation a hand-written one does.

**Acceptance criteria — met.** Verified in a browser: none/template/scratch
all reachable; typing "Put my agent costs at the top" produced a valid
document with the costs section moved first, rendered as a preview with
Apply/Discard, and saved nothing until applied. Invalid edits are rejected by
the loop and never reach the renderer.

**Tests:** 12 data-source tests (aggregation, empty-state, tenant isolation,
catalogue boundary), 13 template tests (round-trip, every source exists,
unique widget ids), 13 AI property tests (seven invalid shapes each rejected,
bounded attempts, refusal surfaced), 14 widget data-binding tests.

**Known ceilings:** dashboards live on agents, so there is no workspace-level
"home" dashboard yet. Widgets refresh by polling (15s; approvals 5s) rather
than subscribing. `taskList` and `calendar` have no backing data and render
as unavailable — tasks arrive in Phase 8. Widget refresh is not covered by a
DOM test; driving the interval needs fake timers installed before mount,
which deadlocks testing-library's async helpers.

---

## Phase 7 — Desktop App + Local Runtime Packaging (and Mobile) ← NEXT

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
