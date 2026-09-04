# Bridge 1.0 → 2.0 — Migration Plan

*The safest path, not the fastest one.*

## Recommendation: incremental migration of the backend, hard rebuild of the frontend

Three options were considered.

**Complete rewrite — rejected.** Roughly 30,000 lines of backend infrastructure
(auth, tenancy, secrets, dual-driver database, queue, providers, sandbox, MCP,
approvals, permissions, event log) are product-neutral and covered by ~10,200
lines of tests. Rewriting them would burn months to arrive back where we
started, and the subtle parts — `FOR UPDATE SKIP LOCKED` claiming, the
resumable frame stack, PGlite's single-connection hazard, secret handling —
are exactly the parts that took longest to get right the first time.

**Incremental everywhere — rejected.** The UI is organised around 1.0's nouns
(agents you configure, chats you have, dashboards you assemble). Bridge 2.0's
nouns are tasks, connections, routes and approvals. Migrating those screens
one at a time means maintaining two mental models in one navigation tree for
months, and the user has already said the UI is a restart.

**Chosen: keep the spine, replace the surface.** Preserve the control plane,
split the runtime along its control/execute seam, add the adapter layer, and
build a new frontend against a new API — with the old UI left running until
the new one can replace it.

---

## 1. Dependency order

What must be true before each thing can be built:

```
core, db, queue           ← already true, nothing blocks
    ↓
auth, tenancy, secrets    ← already true
    ↓
AgentAdapter contract     ← BLOCKS EVERYTHING. Design first, in isolation.
    ↓
adapters (cli-subprocess first, it is 80% written)
    ↓
task orchestrator  ←── reuses claiming + checkpoints from 1.0 executor
    ↓
router (trivial version)     audit + cost (projections of AgentEvent)
    ↓
approvals wiring (reuse)
    ↓
new UI
```

**The critical path is the `AgentAdapter` + `AgentEvent` contract.** Every
other decision depends on it, and getting it wrong is expensive because five
adapters and the entire observability layer are written against it. It should
be designed against *three real runtimes at once* — Claude Code, an API model,
and the in-house loop — before a line of orchestrator code is written. An
interface designed against one implementation always leaks that implementation.

---

## 2. Phase-gated migration

### Gate 0 — Land the baseline (before any pivot work)

There are ~61 uncommitted files spanning Phase 9 observability, the agent
setup form, and the dashboard editor. **Commit or discard them first.** A pivot
that starts from an unlanded working tree cannot be reasoned about or reverted.

Tag the result `v1.0-final`. It is the fallback and the reference.

### Gate 1 — The adapter contract, proven

Build `AgentAdapter` + `AgentEvent`, and *three* adapters that satisfy it:
`cli-subprocess` (reshaping `cli-subscription.ts`), `api-model` (wrapping the
existing providers), and `in-house` (wrapping 1.0's own executor).

Success test: **the same task, submitted to three different runtimes, produces
three normalised event streams that the same code can display.** If that is
true, Bridge 2.0 is buildable. If it is not, stop and redesign — everything
downstream is written against this.

No UI, no orchestrator, no new tables. This is a library plus tests.

### Gate 2 — Split the executor

Extract from `packages/runtime`:

- `packages/orchestrator` — claiming, leases, retries, checkpoints, budgets,
  approval pause/resume. Everything that survives regardless of who executes.
- `packages/agent-runtime` — the loop, native tools, prompt assembly. Becomes
  the `in-house` adapter's internals.

The seam is documented in `CODEBASE_AUDIT.md §2`. This is a *mechanical* split
of existing, tested code — do it with the tests green at every step, not as a
rewrite. `packages/runtime/src/executor.test.ts` (2,839 lines of runtime tests
in total) is the safety net; if a test needs changing to make the split pass,
that is a signal the seam is in the wrong place.

### Gate 3 — Tasks end to end, headless

Task table, orchestrator, trivial router (explicit agent choice only), event
projection into traces and cost. Drive it entirely from the **CLI**, which
already speaks the public API with bearer tokens.

Success test: `bridge task create --agent claude-code "..."` runs, streams,
pauses for an approval, resumes after `bridge approve`, and returns a result —
with the whole thing visible in the audit log.

Proving the loop headlessly is deliberate. It stops UI work from hiding
orchestration bugs, and the CLI is a shipping surface for Bridge Core anyway.

### Gate 4 — The new UI

Only now. Build against the proven API, at `/2/*` routes inside the same app
so both UIs run side by side. Delete 1.0 screens when their replacement is
better, not before.

### Gate 5 — Remove

Dashboard builder, agent templates, `manifest.ts`'s execution fields. Removal
is last, when nothing depends on them and the replacement has shipped.

---

## 3. What is reused, precisely

**Verbatim, no changes expected:** `packages/core`, `packages/queue`,
`apps/worker`, `apps/api/src/auth.ts`, workspaces/members/invitations,
`secrets.ts`, `attachments.ts`, `approvals.ts`, `stream.ts`,
`packages/spec/permissions.ts`, `packages/spec/events.ts`,
`runtime/tools/sandbox.ts`, `runtime/tools/mcp.ts`, `runtime/bus.ts`,
`runtime/budget.ts`, `runtime/approval-expiry.ts`, `components/ui`, design
tokens, `RouteError.tsx`.

**Reshaped, substantial reuse:** `cli-subscription.ts` → cli adapter;
`executor.ts` → orchestrator + in-house adapter; `activity.ts` → observability
API; `agents.ts` → connections API; `automations.ts` → scheduled tasks;
`apps/cli` → new verbs, same client; `toolCatalog.ts` data → integrations.

**Rebuilt from concept:** the architect's `proposeJson` validate-and-retry
technique → task planner. The manifest → connection + identity + task specs.
Templates → workflow templates.

**Parked intact (DEFER):** channels, knowledge/memory, chat + assistant-ui,
search config. None deleted; none in the critical path.

---

## 4. Data migration

Bridge 1.0 has no production users, which removes the hardest constraint. The
plan is therefore *additive*, not transformational:

1. **Add** task tables alongside `runs`. Do not rename in place — the two
   lifecycles differ and a dual-write period is not worth the complexity when
   there is no data to preserve.
2. **Keep** `events`, `approvals`, `attachments`, `secrets`, `provider_configs`
   as they are; extend rather than replace.
3. **Extend** `agents` into connections via the existing `specVersion`
   migration mechanism (already used once, for `dashboard` → `dashboards[]`).
4. **Drop** `workspace_dashboards` last, in Gate 5.

**Before any of this:** add `events` partitioning/pruning. It is unbounded
today and Bridge 2.0 writes more to it, not less.

---

## 5. Debt not to carry forward

| Debt | Why it matters more in 2.0 | Fix |
|---|---|---|
| `events` has no retention | 2.0 audits other agents; volume grows | Partition by month, prune on a schedule — do this in Gate 3 |
| Pricing is code, not versioned data | Cost Tracking is a headline system; today a price change silently rewrites history | `(model, effective_from)` rows, resolved at write time |
| `executor.ts` does two jobs in 1,100 lines | It is the thing being split | Gate 2 |
| `api.ts` is 985 lines | New client should not repeat it | Split per resource in Gate 4 |
| PGlite single-connection deadlock | New orchestrator code is transaction-heavy | Keep transactional scopes small; never query the outer handle inside one |
| No per-agent rate limiting | 2.0 calls third-party CLIs and APIs concurrently | Add at the adapter boundary |
| Approval history has an endpoint but no UI | Audit Log is a named 2.0 system | Fold into the new UI rather than patching 1.0's |

---

## 6. Risks, and what reduces them

| Risk | Severity | Mitigation |
|---|---|---|
| **Adapter contract is wrong** | Highest | Gate 1 exists solely to de-risk this. Design against three runtimes before building on it. |
| **Vendor CLIs change output format** | High | They are unversioned interfaces we do not control. Parse defensively, pin tested versions, contract-test each adapter against a recorded fixture, and fail loudly rather than silently mis-parsing. |
| **Long-running agents outlive HTTP** | High | Already solved: claim-lease-heartbeat plus resumable checkpoints. Reuse, do not reinvent. |
| **Cost attribution is impossible for subscription CLIs** | Medium | Report usage honestly and mark cost as subscription-covered. Never invent a number — a wrong cost is worse than an absent one. |
| **Removing working features demoralises / loses value** | Medium | Nothing is deleted before its replacement ships (Gate 5 is last). DEFER means parked, not destroyed. |
| **Two UIs at once** | Medium | Time-boxed. `/2/*` alongside 1.0, and 1.0 screens deleted per-screen as they are replaced. |
| **Scope creep back toward "Bridge is the agent"** | Medium | The in-house runtime stays *one adapter*, with no special privileges in routing. If it starts getting special-cased, the pivot is failing. |

---

## 7. What success looks like at each gate

- **Gate 1:** three runtimes, one event stream, same rendering code.
- **Gate 2:** tests green, executor split, no behaviour change.
- **Gate 3:** the full loop works from a terminal, including a human approval.
- **Gate 4:** a person who has never seen Bridge can connect an agent and get
  a task done without reading anything.
- **Gate 5:** no 1.0 product surface remains, and the repo is smaller than it
  was.
