# Bridge 2.0 — Phased Roadmap

*The first version should be small enough to be excellent.*

## The loop that must work before anything else

```
CONNECT AGENTS → CREATE TASK → ROUTE TASK → AGENT EXECUTES
     → BRIDGE MONITORS → HUMAN APPROVES WHEN REQUIRED → RESULT RETURNED
```

Everything in Phase 0–3 exists to make this loop work well for **one user,
two agents, one task at a time**. Nothing else ships until it does.

---

## Phase 0 — Land the baseline

**Not pivot work. Do it first.**

- Commit or discard the ~61 uncommitted files (Phase 9 observability, agent
  setup form, dashboard editor). Tag `v1.0-final`.
- Add `events` partitioning and pruning.
- Convert pricing tables to versioned data.

**Done when:** the tree is clean, tagged, and the two pieces of debt that get
worse under 2.0 are fixed.

*Rationale: a pivot from an unlanded working tree cannot be reverted or
reasoned about, and both debts are cheaper to fix now than after the
orchestrator is writing to those tables.*

---

## Phase 1 — The adapter contract

**The only phase that can invalidate the whole plan. Do it in isolation.**

- Define `AgentAdapter` and `AgentEvent`.
- Implement three adapters: `cli-subprocess` (reshape `cli-subscription.ts` —
  it already spawns `claude`, `codex`, `copilot` and reads their auth state),
  `api-model` (wrap existing providers), `in-house` (wrap 1.0's executor).
- Contract tests each adapter must pass identically.

**Acceptance:** the same task submitted to all three produces normalised event
streams that one piece of code renders.

**Ships to users:** nothing. This is a library.

*Do not skip the third adapter. An interface designed against two
implementations still leaks; three is where the abstraction stops lying.*

---

## Phase 2 — Split the runtime

- Extract `packages/orchestrator` (claiming, leases, checkpoints, budgets,
  approvals) from `packages/agent-runtime` (loop, native tools, prompts).
- Mechanical refactor of tested code, tests green at every step.

**Acceptance:** all existing runtime tests pass unchanged. If a test must
change, the seam is wrong.

**Ships to users:** nothing visible.

---

## Phase 3 — The loop, headless

- `tasks` table and lifecycle.
- Orchestrator submitting through adapters.
- Trivial router: explicit agent choice only.
- `AgentEvent` → trace, audit, cost projections.
- Approvals wired end to end (reusing 1.0's pause/resume).
- Driven entirely from the **CLI**.

**Acceptance:**
```
bridge agents connect claude-code
bridge task create --agent claude-code "add a health check endpoint"
# → streams progress
# → pauses: "claude-code wants to write src/health.ts"
bridge approve <id>
# → resumes, completes, returns result
bridge task show <id>     # full trace, cost, timings
```

**Ships to users:** Bridge Core, CLI-only. Genuinely useful to a developer
running two coding agents.

*Proving this headlessly is deliberate — UI work hides orchestration bugs, and
the CLI is a real shipping surface, not a test harness.*

---

## Phase 4 — Bridge 2.0 UI, v1

- New app at `/2/*`, 1.0 still running beside it.
- Home (command input, needs-you, running, agents, recent, cost).
- Tasks list + task detail with live trace.
- Agents: connect, health, capabilities.
- Approvals.
- Reuse: shadcn primitives, design tokens, error boundary, SSE streaming.

**Acceptance:** someone who has never used Bridge connects an agent and
completes a task with an approval, without documentation.

**Ships to users:** Bridge 2.0 v1. **This is the first version worth showing
anyone.**

---

## Phase 5 — Routing that decides

- Capability declarations per agent.
- Router: capability match → policy filter → preference rank.
- Every decision recorded with its reason, and always overridable.
- Performance tracking begins accumulating.

**Acceptance:** a task with no named agent routes correctly and explains why.

---

## Phase 6 — Workflows

- Task graphs with dependencies.
- The headline example works: *"Research our competitors, plan the release,
  implement, review, and ask me before deploying"* → research agent → planning
  agent → coding agent → review agent → human gate.
- Workflow templates.

**Acceptance:** the multi-agent example from the product brief runs end to end
with one human approval.

*This is the demo that explains the entire product. It is deliberately Phase 6
and not Phase 1 — it only impresses if every underlying step is already
reliable.*

---

## Phase 7 — Shared Context

- Workspace context bundle, versioned.
- Per-adapter injection (system prompt / `CLAUDE.md` / MCP resource).

**Acceptance:** a fact written once is known by three different vendors' agents
on their next task.

*Strong candidate to pull earlier if it proves to be the differentiator — it is
the clearest thing no single agent vendor will build.*

---

## Phase 8 — Teams and governance

Teams, spend policies, approval rules, audit export, richer permissions.
**Ships:** Bridge Business foundations.

---

## Phase 9 — Remove 1.0

Delete the dashboard builder, agent templates, and 1.0 routes. Reassess the
DEFER list (channels, knowledge, chat) against real usage rather than
speculation.

---

## Later

Memory, marketplace, optimiser/A-B, mobile (approve from a push notification),
Bridge Cloud.

---

## What is deliberately excluded from v1

Marketplace · cross-agent memory synthesis · A/B architecture testing ·
mobile · channels · the knowledge graph · chat as a primary surface · custom
dashboards.

Each is defensible eventually. None helps the core loop work well, and every
one of them is a way to arrive at a mediocre version of the same product
Bridge is pivoting away from.

---

## Sequencing rationale

The order is driven by **risk, not value**. The riskiest assumption (that five
heterogeneous agent runtimes can hide behind one interface) is tested in
Phase 1, when abandoning costs a week. The most valuable feature (multi-agent
workflows) is Phase 6, because it is only valuable if everything beneath it is
dependable — a workflow that fails halfway with no trace and no recovery is
worse than no workflow at all.
