# Bridge 2.0

Bridge is pivoting from **an agent** to **a control plane for agents**.

Products like Claude Code, Codex, Hermes and Grok are commoditising the
general-purpose agent layer. Bridge should not compete with them
feature-for-feature; it should make them work together, and become *more*
valuable as each of them improves.

```
Human → Bridge → Orchestration / Routing / Permissions / Context
      → Claude Code · Codex · Hermes · Grok · local agents
      → Tools / Apps / Computers / APIs
```

## Status

**Planning complete. No 2.0 code has been written.**

Everything currently in this repository outside `docs/bridge-2.0/` is Bridge
1.0 — a working Agent OS. These five documents describe how it becomes 2.0,
and nothing in them has been implemented.

## The documents

| Document | What it answers |
|---|---|
| [`CODEBASE_AUDIT.md`](CODEBASE_AUDIT.md) | What exists, and what is KEEP / ADAPT / REBUILD / REMOVE / DEFER |
| [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md) | The safest path from here to there, and the debt not to carry |
| [`BRIDGE_2_ARCHITECTURE.md`](BRIDGE_2_ARCHITECTURE.md) | Control plane → orchestrator → router → adapters |
| [`BRIDGE_2_INFORMATION_ARCHITECTURE.md`](BRIDGE_2_INFORMATION_ARCHITECTURE.md) | The new app structure and naming |
| [`BRIDGE_2_ROADMAP.md`](BRIDGE_2_ROADMAP.md) | Phased delivery, smallest useful version first |

## The three findings that matter

**1. Bridge 1.0 accidentally built a good orchestrator.** `packages/runtime`
is two systems fused: an execution half (the agent loop — now commodity) and a
control half (claiming work with `FOR UPDATE SKIP LOCKED`, leases, budgets,
and a serialisable frame stack that lets a run pause for a human and resume in
a *different process*). The control half is exactly what a control plane
needs, it is already covered by ~2,800 lines of runtime tests, and the seam
between the two halves is the 2.0 boundary.

**2. Agent connectivity already half-exists at the wrong altitude.**
`packages/providers/cli-subscription.ts` spawns the `claude`, `codex` and
`copilot` CLIs, reads their auth state, and never stores the subscription
credential. But it implements `Provider` — a completion interface — so it
currently pretends Claude Code is a chat model. Same plumbing, wrong contract.

**3. About 48% of the codebase carries forward** — roughly two-thirds of
everything that is not the frontend.

## Recommended first step

Not 2.0 work: **land the baseline**, add `events` retention, and make pricing
versioned data. Then build the `AgentAdapter` contract in isolation against
three real runtimes before anything is built on top of it.
