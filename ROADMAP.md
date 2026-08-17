# Bridge Agent OS — Roadmap

Phases 0–8 are **complete**: architecture, foundation, accounts, the agent
runtime, tools/permissions/approvals, chat/CLI/channels, dashboards, the
desktop app, and automation. Phase 9 is next. Each phase lists
objective, dependencies, deliverables, acceptance criteria, tests, and risks.

Mobile was scoped into Phase 7 and moved out of it: a mobile client's reason
to exist is approving things while away from the machine, and the push path
that makes that work does not exist until Cloud (Phase 11).

Ordering is intentional: every phase leaves a runnable, testable system.

> **Completion addendum:** several original Phase 2-7 deferrals have since
> shipped. See `docs/PHASES_1_7_COMPLETION.md` before treating the historical
> deferred/known-ceiling lists below as current implementation status.

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

## Phase 7 — Desktop App + Local Runtime Packaging ✅ COMPLETE (mobile deferred)

**Objective:** Deliver the consumer install: a real installer that a normal
user runs with no infrastructure knowledge.

**Delivered**
- **Desktop shell** (`apps/desktop`) on Electron rather than Tauri, with the
  reasoning written down in ADR-0015: what is being packaged is a Node
  server, so Tauri would ship a Rust binary *and* a Node sidecar — two
  languages and an IPC boundary to save perhaps 50 MB from an app that
  already carries a WASM Postgres. Electron's binary *is* the Node runtime
  the API needs, so the app ships one runtime, not two.
- **Runtime supervision** (`supervisor.ts`, no Electron import, so it is
  testable without a display): starts the API, waits until it actually
  answers rather than until the process exists, restarts it on a crash with
  backoff, and **stops trying** after repeated fast failures with an honest
  message. A first start that fails is reported, never retried behind an
  error dialog. The OS picks the port — an installed app cannot assume 4000
  is free — and the API publishes it to `api.url`, which is also how a
  terminal `bridge` finds a desktop instance.
- **Application-data directories** (`packages/core/src/paths.ts`): database,
  agent workspaces, uploads and CLI config move out of repo-relative paths
  to the platform location. A repository with an existing `./.bridge` keeps
  using it, and an existing `~/.bridge/config.json` is migrated rather than
  abandoned.
- **The master key in the OS credential store** (ADR-0016) — macOS Keychain,
  libsecret, Windows DPAPI, reached through the tools each OS already ships
  so no native module is added. This closes a real bug: the local API used
  to generate an *ephemeral* key at boot, so restarting silently orphaned
  every provider credential the user had connected. Where no credential
  store exists, an owner-only key file is used and the app says so.
- **One process, one origin**: the API serves the built web client with a
  history fallback for client routes, `no-cache` on the shell and immutable
  caching on hashed assets. Routes are mounted at `/` *and* `/api`, so one
  bundle works behind the Vite dev proxy and inside the packaged app.
  `bridge dashboard` no longer starts Vite when a build is present.
- **Background operation** as an explicit setting, off by default: with it
  off, closing the window quits Bridge and stops agents; with it on, closing
  puts it away and agents keep running. The tray states which is true rather
  than leaving it to be discovered. Native menus, approval notifications
  that deep-link to the queue, `bridge://` links, and a single-instance lock
  (two copies would open the same embedded database).
- **Installers**: `electron-builder` configuration for dmg + zip (macOS
  arm64/x64), NSIS (Windows x64/arm64) and AppImage + deb (Linux), hardened
  runtime entitlements, and `electron-updater` wired to a generic feed.

**Acceptance criteria**
- ✅ *Install and use with no developer tooling.* Verified from the built
  `Bridge-0.1.0-arm64.dmg`: mounted, copied to a directory, launched. It
  created its data directory, migrated a fresh embedded database, provisioned
  the local owner and workspace, and opened the UI — no Docker, no terminal,
  no port, no sign-in. Also verified as an *upgrade*: the same build launched
  against a data directory an earlier build created, which is the case the
  risks section calls out.
- ✅ *Closing the window does not stop background agents; quitting does, and
  the UI says so.* Verified both ways against the installed app: with the
  setting off, closing the window shut the runtime down (the address file is
  removed on clean exit); with it on, the runtime kept answering `/health`
  after the window closed.
- ❌ *Approve a pending action from a phone notification.* Not delivered —
  mobile is deferred (below). Desktop notifications do reach the approval
  queue.

**Tests:** 6 supervisor tests driving a real child process — faking `spawn`
would only exercise the parts that never break — covering ready-only-when-
answering, restart after a crash, giving up on a crash loop, no restart after
a deliberate stop, and a loud first-start failure. 5 approval-watcher tests
(announce once, announce again only after a decision, stay quiet while the
runtime is down). 7 secret-key tests (env wins, key survives a restart,
honest storage reporting, 0600 fallback, adoption of an on-disk key). 5 path
tests. 8 static-serving tests (deep links, cache rules, API paths staying
JSON under both mounts).

**Deferred, with reasons**
- **Mobile (Expo/React Native) and push notifications.** Not started. Push
  for approvals needs a delivery service that does not exist until Bridge
  Cloud (Phase 11) — a local, loopback-only runtime has nothing to push
  *from*. Building the client before that path exists would mean building it
  twice.
- **Code signing and notarisation.** The macOS build is signed with whatever
  local development identity is present and explicitly *not* notarised, so
  Gatekeeper will warn on another machine. Real distribution needs an Apple
  Developer ID, an Apple ID for notarisation, and a Windows signing
  certificate — credentials, not code. The entitlements and configuration
  they plug into are in place.
- **Windows and Linux artifacts.** Configured but not built here; they need
  those runners (or containers) in CI. Only the macOS artifacts have been
  produced and run.
- **A packaged-app smoke test per OS.** The install → launch → clean first
  run → upgrade → close → quit sequence was verified by hand, not automated.
  Automating it wants CI runners per platform, which is the same missing
  piece as the artifacts above.

**Known ceilings:** the window uses the ordinary OS title bar — an inset one
overlaps the sidebar's own header, and fixing that properly means teaching
the web client it is inside Electron, which is exactly the coupling that
keeps local, self-hosted and Cloud one product. Approvals are polled once a
minute rather than pushed. The update feed URL is a placeholder until there
is a release host.

---

## Phase 8 — Automation, Scheduling and Autonomous Operation ✅ COMPLETE

**Objective:** Always-running Agent OS: schedules, triggers, loops, health.

**Delivered**
- **Schedules that survive the machine being off.** Automations are claimed
  from the database, not held as BullMQ repeatables as this phase originally
  specified — a repeatable job needs Redis, and nothing a desktop user
  depends on may (ADR-0008/0010). It is the same pattern runs already use
  (ADR-0012), and it answers a laptop that was asleep, a process that
  crashed, and a second instance starting, all the same way.
- **Two ways to say when**: cron with a real timezone, evaluated in the
  schedule's own zone so "weekdays at 9am" keeps meaning 9am where the user
  lives across a daylight-saving change; and intervals (`every: "15m"`),
  because the most common automation anyone wants is the one cron expresses
  worst.
- **Loops that end.** `maxRuns`, `until`, and `maxConsecutiveFailures` — the
  last defaulting to 5 rather than infinity. An automation nobody stops is
  the failure mode of this whole feature: it runs while you sleep, spends
  money, and the first you hear of it is the bill. Bounds are enforced by
  the runner, never left to the agent to respect.
- **Event automations**: an event in the log starts a run. Delivery is
  exactly-once against a sequence rather than a timestamp, because two events
  in the same millisecond are indistinguishable by time — one would be
  delivered twice or not at all.
- **The guards that make autonomy safe to leave on**: firing is a
  compare-and-swap inside the transaction that inserts the run, so two
  runners produce one run and a crash produces both or neither; an automation
  never stacks on itself; a run over the agent's daily budget is skipped with
  a reason rather than disabling the schedule, because tomorrow it works
  again; and automated runs cannot trigger event automations, which is what
  rules out a cycle.
- **A workspace timezone** (Settings), which is what "9am" means for any
  schedule that does not name its own zone — validated against the platform's
  own zone database, because a typo here is a schedule that fires at the
  wrong hour forever.
- **Control**: pause, resume, edit, delete and run-now, in the UI, the CLI
  and the chat box. Editing and deleting write the *agent's manifest*, not
  the row: a row changed on its own would be silently reverted by the next
  reconcile. Resuming rejoins the rhythm from now instead of firing for every slot
  it missed; resuming a *finished* loop starts its count over, because
  otherwise "resume" is a dead end that re-completes on the next tick.
- **One command catalogue for every surface** (`@bridge/commands`): `bridge
  approve x` in a terminal and `/approve x` in the chat box are the same
  value, not two implementations that drift. Commands return structured
  results — text, a table, somewhere to go — and each client renders them.
  Typing `/` in any chat box opens the palette; the CLI's own dispatch was
  rewritten to run the same definitions, and its duplicated implementations
  deleted rather than left to rot.
- **An Automations page** showing what runs next, why something stopped, and
  how to stop it — plus the reason in words, never hidden behind a hover.
- **Conversations that say what happened.** A run only wrote to its
  conversation on success, so a scheduled run that failed — or one still
  going — left a thread that looked identical to a brand new chat. The
  prompt is now recorded when the run is created, and the conversation
  carries its runs, so a failure reads as a failure instead of as silence.

**Acceptance criteria**
- ✅ *Manifest trigger → execution.* Verified live: an agent with three
  schedules (a New York weekday cron, a 30s interval, and a 3-run loop) was
  deployed against a running Bridge. The cron resolved to Monday 13:00 UTC —
  9am in New York, across the DST boundary — the intervals fired on time, and
  the bounded loop stopped itself after exactly 3 runs with the reason
  "finished after 3 runs".
- ✅ *No duplicate side effects.* The claim is a compare-and-swap in the same
  transaction as the run insert; two runners ticking concurrently produce one
  run, which is asserted rather than argued.
- ✅ *Users see automation health.* Status, the reason it stopped, next run,
  and run count, in the page and in `/automations`.
- ⚠️ *"Run the research agent every weekday morning" from natural language.*
  The architect writes and validates the whole manifest, and its prompt now
  teaches the trigger shape — cron versus interval, timezones, and the rule
  that a bounded task must say where it ends. **This path is not verified
  end to end**: doing so needs a real model credential, which this
  environment has none of. Everything downstream of the manifest is verified.

**Tests:** 41 in the runtime — 17 on scheduling arithmetic (timezones, DST,
loop endings) and 24 driving the runner against a real database (racing
runners, a missed window, crash loops, budgets, the cycle guard). 13 on the
API (control, and tenant isolation). 18 on the command registry, including
one asserting every command reaches Bridge only through `/v1` endpoints.

**Deferred, with reasons**
- **A dead-letter queue and replay.** Failed runs are visible per agent and a
  failing automation disables itself with a reason, but there is no separate
  queue of poisoned work to inspect and re-drive. That belongs with the run
  history and search work in Phase 9 rather than as a second surface here.
- **Agent-level health beyond automations.** An automation reports its own
  state; a rollup of "is this agent well" is Phase 9.
- **Chained automations.** An automated run's events cannot trigger another
  automation. That rules out runaway cycles, and it also rules out chaining;
  doing both needs a depth or provenance model, which is not worth its
  failure modes until someone actually wants it.

**Known ceilings:** the runner polls every 5s and re-reads manifests every
60s, so a schedule added by editing an agent's manifest directly starts
within a minute — deploying, stopping, or editing through the Automations
page reconciles immediately. Firing
is once per pass per automation, so a burst of events becomes a paced queue
rather than a stampede — correct, but not fast. Local schedules only run
while Bridge is running; the desktop app says so, but there is no catch-up
report of what was missed.

---

## Phase 9 — Observability ← NEXT

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
connection. **Mobile (Expo/React Native) lands here**, deferred from Phase 7:
it shares the API client and design tokens, not web DOM code, and its point
is approving a paused run from a push notification — which needs a delivery
service a loopback-only local runtime cannot provide.

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
