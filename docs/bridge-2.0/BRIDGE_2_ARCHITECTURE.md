# Bridge 2.0 — Proposed Architecture

*Conceptual design. Deliberately short on implementation detail.*

## The one-sentence version

Bridge 2.0 is a **durable, auditable task router** that submits work to agents
it does not own, pauses when a human must decide, and records what happened.

Everything below serves that sentence.

---

## 1. The stack

```
┌───────────────────────────────────────────────────────────────┐
│  BRIDGE UI            web · desktop · CLI · (later) mobile    │
│  one API, no privileged client                                │
└───────────────────────────────┬───────────────────────────────┘
                                │  HTTP + SSE
┌───────────────────────────────▼───────────────────────────────┐
│  CONTROL PLANE                                                │
│  auth · tenancy · identity · permissions · secrets · audit    │
│  ── the only layer that talks to the database directly ──     │
└───────────────────────────────┬───────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────┐
│  TASK ORCHESTRATOR                                            │
│  lifecycle · dependencies · retries · budgets · checkpoints   │
│  pauses for approval; resumes in any process                  │
└───────────────────────────────┬───────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────┐
│  AGENT ROUTER                                                 │
│  capability match → policy filter → cost/latency rank         │
│  explains every choice; a human can always override           │
└───────────────────────────────┬───────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────┐
│  AGENT ADAPTER LAYER            one contract, many runtimes   │
│  claude-code · codex · copilot · hermes · grok · api-model    │
│  · mcp-agent · in-house · http-webhook                        │
└───────────────────────────────┬───────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────┐
│  EXTERNAL AGENTS  →  TOOLS / APPS / COMPUTERS / APIs          │
└───────────────────────────────────────────────────────────────┘
```

**Direction of dependency is strictly downward.** The router knows nothing
about HTTP; the orchestrator knows nothing about Claude Code; adapters know
nothing about workspaces. This is what keeps Bridge Cloud from drifting from
Bridge Core — Cloud implements interfaces Core already defines (ADR-0008's
lesson, carried forward).

---

## 2. The Agent Adapter contract — the keystone

Bridge 1.0's `Provider` interface asks *"complete this conversation"*. That is
the wrong question for an agent. Claude Code does not complete a conversation;
it takes a job, works for minutes, touches files, and reports back.

The new contract, conceptually:

```
interface AgentAdapter {
  id, displayName, kind

  // What can this agent actually do? Drives routing.
  capabilities(): Capability[]        // e.g. code.write, research, review

  // Is it reachable and authenticated right now?
  health(): { reachable, authenticated, account?, detail? }

  // Submit work. Returns a handle, not a result — work is long-lived.
  submit(task: TaskSpec, ctx: AgentContext): Promise<AgentHandle>

  // Progress as it happens: output, tool intentions, completion.
  observe(handle): AsyncIterable<AgentEvent>

  // Bridge decided; tell the agent.
  respond(handle, decision: ApprovalDecision): Promise<void>

  cancel(handle): Promise<void>
}
```

`AgentEvent` is the single most important type in Bridge 2.0. It normalises
five wildly different runtimes into one stream Bridge can record, display and
bill:

```
| { type: "output",    text }
| { type: "step",      tool, action, arguments, status }
| { type: "needs_approval", tool, action, arguments, reason }
| { type: "usage",     inputTokens, outputTokens, costUsd? }
| { type: "artifact",  name, mimeType, ref }
| { type: "done",      outcome: ok | failed | refused | cancelled, summary }
```

Everything downstream — traces, audit log, cost tracking, approvals, the live
Home page — is a projection of this stream. Get this type right and the rest
of the system is bookkeeping.

**Adapter kinds at launch:**

| Kind | How | Notes |
|---|---|---|
| `cli-subprocess` | spawn `claude` / `codex` / `copilot` | ~80% exists in `cli-subscription.ts` |
| `api-model` | Anthropic / OpenAI-compatible | exists; wrap as a trivial agent |
| `in-house` | Bridge 1.0's own loop | the whole 1.0 runtime becomes *one adapter* |
| `mcp-agent` | MCP server exposing agent-shaped tools | client exists |
| `http-webhook` | submit + callback | for Hermes / remote / custom |

**Credential principle, carried from 1.0 and strengthened:** where a vendor
CLI already holds a session, Bridge invokes the CLI and never touches the
credential. Where Bridge must hold a key, it goes in the encrypted store with
the master key in the OS keychain. Bridge 2.0 holds *more* third-party
credentials than 1.0, so this is the security centre of gravity.

---

## 3. Task Orchestrator

A **Task** is the atomic unit: a request, a routing decision, an assigned
agent, a lifecycle, a trace, a cost, a result.

```
requested → planned → routed → running ⇄ waiting_approval
                                   ↓
                    succeeded | failed | cancelled | refused
```

Reused directly from 1.0:

- **Claim from the database** with `FOR UPDATE SKIP LOCKED` (ADR-0012). No
  queue required for local; BullMQ for scale. One code path.
- **Serializable checkpoints** (ADR-0013). A task pauses mid-flight, persists
  its state, and resumes in a *different process* after a human decides. This
  is already built and tested and is the hardest thing here.
- **Budgets** enforced before work starts, not after money is spent.
- **Leases and heartbeats** so a crashed worker's task is reclaimed.

New in 2.0:

- **Workflows**: a DAG of tasks with dependencies, so "research → plan →
  implement → review → deploy(human)" is one object. Each node routes
  independently. A workflow is a *task that owns tasks* — reusing delegation
  semantics rather than inventing a second execution model.

---

## 4. Agent Router

Three stages, in order, each one explainable:

1. **Capability match** — which connected agents claim they can do this?
2. **Policy filter** — which is this workspace/user *allowed* to use for this?
   (Permissions run before preference, never after.)
3. **Rank** — by declared preference, historical success rate on similar
   tasks, cost, and latency.

Two rules:

- **Every routing decision is recorded with its reason.** "Chose Claude Code:
  capability `code.write`, 94% success on this repo, £0.12 est." A router that
  cannot explain itself cannot be trusted with a budget.
- **The human can always pin.** Routing is a default, not a verdict.

Bridge should ship with the dumbest router that works — declared capability +
explicit preference — and earn its way to scoring. Historical-performance
routing needs history, and there is none on day one.

---

## 5. The cross-cutting systems

**Agent Identity.** Every agent instance has a stable Bridge-side identity:
who it is, which adapter backs it, what it may do, whose credentials it uses,
what it has done. Tasks reference identities, not adapters — so swapping
Claude Code for Codex behind an identity keeps the audit trail continuous.

**Permissions.** Reuse 1.0's policy engine unchanged (ordered rules, first
match wins, `ask` default, dangerous-by-default downgraded to `ask`). Extend
the resource vocabulary from `tool:*` to also cover `agent:*`, `repo:*`,
`spend:*`. The evaluation function does not change.

**Approvals.** Reuse wholesale. Extend the request to carry *which agent*
asked, so a human approving a file write knows whether Codex or Claude Code
wants it.

**Shared Context.** A workspace-scoped, versioned bundle (project facts,
conventions, links, glossary) that Bridge injects into every agent it calls,
in whatever form that agent accepts — a system prompt for one, a `CLAUDE.md`
for another, an MCP resource for a third. **This is a genuine Bridge moat:**
context that follows you across vendors is something no single agent vendor
will build.

**Shared Memory.** Durable outcomes across agents and time. Deliberately later
than Context: context is authored, memory is derived, and derived state is
worth less until there is history to derive from.

**Audit Log.** The existing append-only `events` table with its monotonic
`seq`. Add routing decisions, approvals, credential use, permission denials.
Immutable, exportable, the Bridge Business selling point.

**Cost Tracking.** Normalise `usage` events across adapters. Two hard parts,
both known: CLI-subscription agents report no per-call price (attribute usage,
mark cost "covered by subscription" rather than inventing a number), and
pricing must be versioned data so history stays truthful.

**Performance Tracking.** Success rate, latency, retry count, approval rate,
per agent and per task type. Feeds the router's third stage — and only becomes
useful once there is history, which is the argument for shipping the simple
router first.

---

## 6. What deliberately is *not* in this architecture

- Bridge does not try to be the smartest agent. The in-house runtime is one
  adapter among several, and the least important one.
- No marketplace, no A/B optimiser, no cross-agent memory synthesis at launch.
- No new database. The existing dual-driver Postgres design carries 2.0.
