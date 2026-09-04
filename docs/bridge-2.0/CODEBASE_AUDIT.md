# Bridge 1.0 → 2.0: Codebase Audit

*Analysis only. No production code was changed to produce this document.*

## How to read this

Every significant component is classified **KEEP / ADAPT / REBUILD / REMOVE /
DEFER**, with the reason. The single question applied throughout:

> Bridge 1.0 assumed **Bridge is the agent**. Bridge 2.0 assumes **Bridge
> controls agents**. Does this component serve the second sentence?

Components that answer "yes" are usually infrastructure. Components that
answer "no" are usually product surface.

---

## 1. The repository as it stands

Measured, not estimated (source files, `.ts`/`.tsx`, excluding `node_modules`):

| Package | Files | Lines | of which tests |
|---|---:|---:|---:|
| `apps/web` | 94 | 19,629 | 1,079 |
| `apps/api` | 44 | 8,949 | 3,675 |
| `packages/runtime` | 29 | 7,563 | 2,839 |
| `packages/spec` | 36 | 3,378 | 353 |
| `apps/cli` | 11 | 2,056 | 430 |
| `packages/providers` | 7 | 1,940 | 511 |
| `packages/channels` | 11 | 1,385 | 377 |
| `packages/core` | 13 | 918 | 299 |
| `apps/desktop` | 6 | 928 | 248 |
| `packages/commands` | 5 | 812 | 143 |
| `packages/db` | 5 | 795 | 52 |
| `packages/sdk` | 6 | 316 | 66 |
| `packages/queue` | 5 | 260 | 94 |
| `apps/worker` | 3 | 158 | 16 |
| **Total** | **275** | **≈49,100** | **≈10,200** |

Supporting assets: 25 database tables, 13 SQL migrations, 16 ADRs, ~644
passing tests, 19 model providers in the catalogue, 6 channel adapters.

**Stack:** TypeScript (strict, ESM, Node ≥22), pnpm workspaces + Turborepo,
Biome, Vitest. Hono API, Drizzle ORM over one Postgres dialect with two
drivers (`postgres.js` server / PGlite embedded), React 19 + Vite + Tailwind
v4 + shadcn/ui, **Electron** desktop shell.

> **Correction to the brief:** the task description refers to "Tauri desktop
> infrastructure". This repository does not use Tauri. It uses **Electron**
> (ADR-0015), chosen deliberately because the local runtime is a Node process
> and Electron lets the shell and the runtime share one language and one
> bundling story. Any Bridge 2.0 plan that assumed Tauri should be re-checked:
> the desktop layer is small (928 lines) and re-platformable, but nothing is
> currently written against Tauri APIs.

---

## 2. The central architectural finding

`packages/runtime` is not one thing. It is two things fused together, and the
seam between them is exactly the Bridge 2.0 boundary.

**The control half** — what an orchestrator does:

| File | Role | Verdict |
|---|---|---|
| `executor.ts` (claim/lease/retry/heartbeat portion) | Claims work `FOR UPDATE SKIP LOCKED`, leases it, reclaims stale, retries with attempt counting | **KEEP** |
| `loop.ts` (frame stack + checkpoints) | Serializable execution state so work can pause for a human and resume **in a different process** | **KEEP** |
| `budget.ts` | Daily token/spend ceilings, enforced before work starts | **KEEP** |
| `approval-expiry.ts` | Times out decisions nobody made | **KEEP** |
| `bus.ts` | In-process fan-out + wake-on-work | **KEEP** |
| `schedule.ts`, `automations.ts` | Cron/interval triggers with loop bounds | **ADAPT** |
| `resolver.ts` | The model-resolution chain | **ADAPT** |
| `secrets.ts` | Per-agent scoped secret resolution | **KEEP** |

**The execution half** — what an *agent* does, and therefore what Bridge 2.0
delegates to somebody else's agent:

| File | Role | Verdict |
|---|---|---|
| `executor.ts` (agent-loop portion) | Builds prompts, calls a model, interprets tool calls | **ADAPT → becomes one adapter** |
| `tools/native.ts` | filesystem, shell, http, web-search, image | **ADAPT → in-house adapter's toolset** |
| `tools/sandbox.ts` | Path confinement, network class restriction | **KEEP** |
| `tools/mcp.ts`, `tools/registry.ts` | MCP client, grant resolution | **KEEP** |
| `charter.ts` | Generates `IDENTITY/SOUL/USER/AGENTS.md` per agent | **REBUILD** |
| `knowledge.ts` | Journal → graph consolidation | **DEFER** |
| `images.ts`, `search.ts` | Intrinsic capabilities | **DEFER** |

**Why this matters more than anything else in the audit:** the hardest,
most-tested, most-debugged parts of Bridge 1.0 — durable work claiming,
pause-for-human-and-resume-elsewhere, budget enforcement, ordered traces —
are *precisely* the parts a control plane needs, and they are already built
and covered by 2,839 lines of tests. The part that must be replaced (the
in-house agent loop) is the part that is now commodity.

Bridge 1.0 accidentally built a good orchestrator while trying to build an
agent. **That is the asset.**

---

## 3. Component-by-component

### 3.1 Foundation — almost entirely KEEP

| Component | Lines | Verdict | Reasoning |
|---|---:|---|---|
| `packages/core` — ids, errors, env, logging, crypto, keychain, paths | 918 | **KEEP** | Nothing here is product-shaped. AES-256-GCM secret crypto, OS keychain integration (ADR-0016), prefixed ids, the error envelope. Bridge 2.0 needs all of it unchanged. |
| `packages/db` — Drizzle schema + two drivers | 795 | **KEEP (schema ADAPT)** | The driver strategy (one dialect, `postgres.js` + PGlite, ADR-0009) is a genuine competitive advantage: local-first with no Docker. Keep wholesale. Individual *tables* are adapted — see §3.6. |
| `packages/queue` — JobQueue iface, BullMQ + in-process | 260 | **KEEP** | Small, correct, driver-shaped (ADR-0010). |
| `apps/worker` | 158 | **KEEP** | A thin host for the executor. Survives whatever the executor becomes. |
| Secret storage (`core/crypto` + `core/keychain` + `runtime/secrets`) | — | **KEEP** | Encrypted at rest, master key from OS credential store on desktop, operator-supplied on server, API only ever returns a masked hint. Bridge 2.0 stores *more* third-party credentials than 1.0 (every connected agent has one), so this becomes more load-bearing, not less. |

### 3.2 Auth and tenancy — KEEP

| Component | Verdict | Reasoning |
|---|---|---|
| `apps/api/src/auth.ts` — sessions, API tokens, roles, OIDC/PKCE SSO | **KEEP** | Complete and unexciting in the best way. Password + session cookies, bearer tokens for CLI, `requireAuth`/`requireWorkspace`/`requireRole` middleware, full OIDC discovery with PKCE. Bridge Business needs exactly this. |
| `workspaces`, `workspace_members`, `workspace_invitations` | **KEEP** | Multi-tenancy is already threaded through every query. Tenant-isolation tests exist (`isolation.test.ts`). |
| Local mode (ADR-0014) | **KEEP** | Auto-provisions one owner, binds loopback, tied to the embedded DB so a real server can never silently drop auth. This is Bridge Core's story. |

### 3.3 Agent connectivity — the crown jewel, at the wrong altitude

| Component | Lines | Verdict | Reasoning |
|---|---:|---|---|
| `packages/providers/cli-subscription.ts` | ~370 | **ADAPT — highest value in the repo** | Already shells out to the `codex`, `claude`, and `copilot` CLIs, reads their auth status, parses their output, and *never stores the subscription credential itself*. This is 80% of an "Agent Connection" already working. **But it implements `Provider`** — a request/response completion interface — so it currently pretends Claude Code is a chat model. Bridge 2.0 needs it reshaped as an **Agent Adapter**: submit a task, stream progress, surface tool calls for approval, return an artifact. Same subprocess plumbing, different contract. |
| `packages/providers/anthropic.ts`, `openai-compatible.ts` | ~1,100 | **KEEP** | Retry/backoff honouring `Retry-After`, streaming, token accounting. Bridge 2.0 still needs raw model access for its own routing/planning decisions. |
| `packages/providers/pricing.ts` | ~200 | **KEEP (ADAPT)** | Cost tracking is a named Bridge 2.0 system. Needs versioning (see MIGRATION_PLAN §debt). |
| `packages/sdk` — `Provider`, `BridgeTool`, `Channel` | 316 | **ADAPT** | The adapter-SDK instinct (ADR-0007) is exactly right for Bridge 2.0. The *interfaces* are wrong: there is no `Agent` interface, which is the one Bridge 2.0 is built on. Add `AgentAdapter` alongside; keep `BridgeTool` and `Provider`. |
| `packages/runtime/tools/mcp.ts` | ~250 | **KEEP** | MCP client with per-grant expansion. MCP is how Bridge 2.0 talks to tools regardless of which agent runs them. |

### 3.4 Orchestration primitives — KEEP, and promote

| Component | Verdict | Reasoning |
|---|---|---|
| Run claiming (ADR-0012) | **KEEP** | `FOR UPDATE SKIP LOCKED` means desktop (no Redis) and server (BullMQ) share one execution path. Bridge 2.0 adds remote execution; this pattern extends to it. |
| Approval checkpoints (ADR-0013) | **KEEP — this is the moat** | A run pauses, serializes its frame stack, and resumes in a **different process** after a human decides. "Human approves when required" is step 6 of the Bridge 2.0 core loop, and it is *already built and tested*. Nothing else in this repo would be harder to rebuild. |
| `approvals` table + `apps/api/src/approvals.ts` | **KEEP** | Decision records with reason, expiry, tenant scoping. |
| Permission policy (`packages/spec/permissions.ts`) | **KEEP** | Ordered rules, first match wins, `ask` default, and `decideToolPermission` downgrades a dangerous-but-only-default-allowed action to `ask`. 79 lines carrying the entire safety posture. Bridge 2.0 applies it to *agents* as well as tools. |
| `packages/runtime/tools/sandbox.ts` | **KEEP** | Path confinement + DNS-resolving network restriction. Still needed for locally-executed agents. |
| Event log (`events` table + `spec/events.ts`) | **KEEP** | Monotonic `seq` (not timestamps — explicitly because two events in one millisecond cannot be ordered by time). Already emits `task.created`/`task.completed`/`task.failed`. Audit Log is a named Bridge 2.0 system and this is its spine. |
| `run_steps` ordered trace | **KEEP → rename** | Every model call, tool call, delegation and error, ordered by `seq`. This is the Observability substrate. In 2.0 the producer changes (an external agent reports steps rather than the loop recording them) but the table and its readers survive. |

### 3.5 API layer — mostly KEEP

`apps/api` mounts 20 route groups. Verdicts:

| Routes | Verdict | Reasoning |
|---|---|---|
| `auth`, `workspaces`, `secrets`, `providers`, `attachments`, `approvals`, `stream` | **KEEP** | Infrastructure. Unchanged by the pivot. |
| `activity` (runs list, trace, usage, health) | **KEEP** | Built last week, keyset-paginated, tenant-scoped, aggregates in SQL. Becomes the Observability + Cost Tracking API almost verbatim. |
| `runs` | **ADAPT → `tasks`** | The concept survives; the noun and the lifecycle change (a task is routed to an agent rather than executed by us). |
| `agents` | **ADAPT** | Becomes *Connections* + *Agent Identity*. CRUD shape survives; the payload changes from "manifest we execute" to "credentials and capabilities of something we call". |
| `automations` | **ADAPT** | Schedules that create tasks. Sound concept, small change. |
| `memory` | **DEFER** | Shared Memory is a named 2.0 system but not in the first loop. |
| `search` | **DEFER** | Workspace web-search config. Belongs to the in-house agent. |
| `channels` + `channel-webhooks` | **DEFER** | Telegram/Discord/Slack inbound → run. Genuinely working, genuinely not needed to prove the core loop. Park it; do not delete it. |
| `architect` | **REBUILD** | Natural language → Bridge Manifest, with a validate-and-retry loop. The *technique* (`proposeJson`, feed validation errors back, never show an invalid document) is excellent and should be lifted wholesale into the Bridge 2.0 **task planner** — which decomposes a request into a routed multi-agent plan. The *output type* is obsolete. |
| `dashboards` + `data` | **REMOVE** | The dashboard builder is 1.0 product surface. Bridge 2.0's Home is a designed mission-control page, not a user-assembled widget grid. See §4. |

### 3.6 Data model

| Tables | Verdict | Reasoning |
|---|---|---|
| `workspaces`, `users`, `sessions`, `api_tokens`, `oidc_states`, `auth_identities`, `workspace_members`, `workspace_invitations` | **KEEP** | Untouched by the pivot. |
| `secrets`, `provider_configs` | **KEEP** | Extend `provider_configs` to cover agent connections. |
| `runs`, `run_steps`, `run_stream_events` | **ADAPT** | Rename to task-shaped; keep the columns, indexes, and the streaming/batching design. |
| `approvals` | **KEEP** | |
| `events` | **KEEP** | Needs partitioning/pruning — see debt. |
| `agents` | **ADAPT** | `manifest` jsonb becomes a connection/identity document. |
| `automations` | **ADAPT** | |
| `attachments` | **KEEP** | |
| `conversations`, `messages` | **DEFER** | Chat is 1.0's primary surface and 2.0's secondary one. The tables are fine; the product weight moves off them. |
| `memory_entries`, `knowledge_nodes`, `knowledge_edges` | **DEFER** | Good work, wrong phase. Shared Org Memory will want a different shape (cross-agent, not per-agent). |
| `workspace_dashboards` | **REMOVE** | |
| `search_configs` | **DEFER** | |

### 3.7 `packages/spec` — the pattern KEEPs, the content REBUILDs

| Component | Verdict | Reasoning |
|---|---|---|
| The Zod-single-source discipline (ADR-0002) | **KEEP — non-negotiable** | One schema, parsed at every boundary, with `migrations[n]` for versioned upgrades. This is why the codebase is safe to change. Bridge 2.0 must keep it. |
| `manifest.ts` (328 lines) | **REBUILD** | Describes an agent Bridge executes: agent definitions, tool grants, models, sandbox. In 2.0 most of this belongs to *someone else's* agent. Splits into a small `Connection` schema, an `AgentIdentity` schema, and a `TaskSpec`. |
| `permissions.ts` | **KEEP** | |
| `events.ts` | **KEEP** | |
| `duration.ts`, `common.ts` | **KEEP** | |
| `dashboard.ts`, `dashboards.ts` | **REMOVE** | |
| `sources.ts` | **REMOVE** | Closed catalogue of dashboard data bindings. |
| `templates/` (20 agent templates, ~1,900 lines) | **REMOVE as agents / REBUILD as task templates** | These describe *in-house agents* ("you are a personal assistant, here are your tools"). Bridge 2.0 templates describe *routed workflows* ("research → plan → implement → review → approve"). The catalogue-as-data pattern is right; every row of content is obsolete. |

### 3.8 Frontend — REBUILD

`apps/web` is 19,629 lines, 40% of the repository. The user has stated the UI
is a restart. The audit agrees, with salvage:

| Component | Lines | Verdict | Reasoning |
|---|---:|---|---|
| `components/ui` (shadcn primitives) | 2,089 | **KEEP** | Unopinionated button/dialog/select/table primitives. Reuse directly. |
| Design tokens, `theme.tsx`, `packages/ui` assets | ~400 + 17 assets | **KEEP** | |
| `api.ts` client (985 lines) | **ADAPT** | The *shape* — typed fetch, `BridgeApiError` envelope, defaulting unknown fields at the boundary — is good and hard-won. Endpoints change. |
| `RouteError.tsx`, `ProviderLogo`, `ToolIcon` | ~400 | **KEEP** | Error boundary and icon resolution are product-neutral. |
| `components/assistant-ui` | 3,254 | **DEFER** | Full chat surface: streaming, reasoning, attachments. Excellent, and chat is no longer the centre. Park intact for when 2.0 needs a conversation view. |
| `routes/*` (7,431 lines) | **REBUILD** | Chat, Agents, AgentSetup, Dashboards, Knowledge, Channels, Automations, Providers, Settings, Activity. Every one is organised around 1.0's nouns. |
| `dashboard/` (grid, widgets, editor) | ~1,500 | **REMOVE** | |
| `toolCatalog.ts` | 468 | **ADAPT** | 30+ connector definitions with URLs and credential hints. The *data* is reusable for Integrations; the manifest-mutation helpers are not. |

### 3.9 Clients

| Component | Lines | Verdict | Reasoning |
|---|---:|---|---|
| `apps/cli` | 2,056 | **ADAPT** | Talks to the same public API with bearer tokens — architecturally correct. A control plane wants a strong CLI (`bridge task create`, `bridge agents ls`). Keep the client/render layers, replace the command set. |
| `packages/commands` | 812 | **ADAPT** | One command catalogue shared by CLI and web palette. Right idea, 1.0 verbs. |
| `apps/desktop` (Electron) | 928 | **KEEP** | Supervises the local runtime, tray, notifications, approval prompts. Bridge 2.0's local-first story needs exactly this, and *more*: locally-installed agents (Claude Code, Codex) run on the user's machine, so the desktop shell moves from convenience to requirement. |
| `packages/channels` | 1,385 | **DEFER** | |

---

## 4. What should be removed, and why it is worth saying plainly

**Remove now:** the dashboard builder (schema, renderer, editor, data-source
catalogue, API, ~2,500 lines end to end) and the 20 in-house agent templates.

The dashboard builder is good engineering. It was finished days ago. The
argument for removing it anyway: Bridge 2.0's Home page is a *designed*
mission-control view — active tasks, agent status, approvals, cost, success
rate. Those are known, fixed, high-value panels. A user-assembled widget grid
is a worse answer to a question 2.0 already knows the answer to, and keeping
it means maintaining a second, generic rendering path forever.

**Keep the ideas, drop the code:** the widget/data-source split (a panel names
a source; the server resolves it against a closed catalogue) is the right
pattern for the fixed Home panels. Reuse the thinking, not the files.

---

## 5. Technical debt not to carry forward

1. **The `events` table has no partitioning or pruning.** Verified: no
   retention logic anywhere in the repo. Every run writes multiple rows.
   Bridge 2.0 makes this worse — it audits *other people's* agents. This must
   be solved before it becomes a migration under load.
2. **Pricing tables are code, not versioned data.** A price change silently
   rewrites the cost of historical runs. Cost Tracking is a named 2.0 system;
   it needs `(model, effective_from)` rows.
3. **PGlite is a single connection.** Querying the outer handle inside a
   transaction deadlocks. It has bitten this codebase repeatedly. Any new
   orchestrator code must be written with this in mind, and it argues for
   keeping transactional scopes small in the task router.
4. **`apps/web/api.ts` is a 985-line module.** Whatever replaces it should be
   split per resource from the start.
5. **`executor.ts` is 1,100 lines doing two jobs.** Splitting it along the
   control/execute seam is the single highest-value refactor available.
6. **`specVersion` is at 2 with one migration.** The mechanism works (it was
   exercised last week moving `dashboard` → `dashboards[]`). Bridge 2.0's
   schema split is a third migration, not a new mechanism.
7. **~61 uncommitted files across several sessions.** Phase 9 observability,
   the agent setup form, and the dashboard editor are all unlanded. This
   should be resolved *before* a pivot, so the baseline is a known commit.

---

## 6. Summary table

| Verdict | Approx. lines | Share |
|---|---:|---:|
| **KEEP** — infrastructure reused essentially as-is | ~14,500 | 30% |
| **ADAPT** — reshaped, substantial reuse | ~9,000 | 18% |
| **REBUILD** — concept survives, code replaced | ~11,500 | 23% |
| **REMOVE** — obsolete product surface | ~4,500 | 9% |
| **DEFER** — parked intact, revisited later | ~9,600 | 20% |

**Reusable without a rewrite (KEEP + ADAPT): ≈48% of the codebase**, and
approximately **two-thirds of everything that is not the frontend**.
