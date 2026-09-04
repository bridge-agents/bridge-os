# Bridge 2.0 — Information Architecture

*Structure and naming. Not visual design.*

## Assessment of the proposed structure

The starting point in the brief is sound. Five changes are proposed, each for
a stated reason.

**1. Collapse WORK into the top level.** Tasks *are* the product. Making
someone open a section to reach the main object adds a click to the most
common action in the app. Tasks and Activity move up; Workflows sits under
Tasks because a workflow is a task that owns tasks.

**2. Merge Agents / Teams / Connections into one section with two levels.**
A "connection" and an "agent" are the same thing seen twice — you connect
Claude Code, and now you have a Claude Code agent. Two sibling nav items for
one mental object is the most likely place for a new user to get lost. One
**Agents** list; adding one is an action, not a destination; a team is a saved
group.

**3. Rename Knowledge → Context.** "Knowledge" was 1.0's derived
memory-graph. Context is authored and immediate; Memory is derived and later.
Leading with Context matches what ships first and is the clearer word.

**4. Fold Permissions and Audit under Control, keep Approvals top-level.**
Approvals are *time-sensitive work* — the thing a person must act on, often
with an agent blocked and waiting. It belongs beside Tasks, not filed under
governance. Permissions and Audit are settings and history; they belong under
Control.

**5. Drop BUILD.** Templates belong with Tasks (a template is a way to start
one). Integrations belong with Agents (they are what agents reach). A section
containing two unrelated things is a container, not a category.

---

## Proposed structure

```
HOME                     mission control — the default landing page

TASKS                    the main object
  All tasks              filter by status, agent, workflow
  Workflows              multi-step task graphs
  Templates              ready-made tasks and workflows

APPROVALS         (n)    always visible, always counted

AGENTS
  Agents                 connected agents, health, capability, cost
  Teams                  saved groups with routing preferences
  Integrations           tools and services agents can reach

ACTIVITY                 the live and historical record
  Timeline               everything, newest first
  Traces                 one task, step by step
  Costs                  spend by agent, task, period

CONTEXT
  Shared context         what every agent is told
  Memory                 what Bridge has learned      [later]

CONTROL
  Permissions            who and what may do what
  Audit log              immutable record
  Policies               spend caps, approval rules   [later]

SETTINGS
  Workspace · Members · Providers · Secrets · Appearance · Advanced
```

**Persistent chrome:** a command input reachable from anywhere (`⌘K`) that
creates a task, and a live approvals count. Those two are the app's pulse.

---

## Home — the page that has to earn the pivot

The brief lists: command/task input, active tasks, connected agents, agent
status, approvals, recent activity, cost, success rate.

That is the right content. The important decision is **hierarchy**, because
listing all eight equally produces a wall of numbers.

Ordered by what a user needs first:

1. **Command input.** Top, large, focused on load. The primary action of the
   entire product is "give Bridge something to do", and it should be
   impossible to miss.
2. **Needs you** — approvals and blocked tasks. Work that is *stopped* pending
   a human is the most expensive state in the system. Show it second or people
   will not notice it. Empty state: absent entirely, not an empty card.
3. **Running now** — active tasks with agent, elapsed time, live progress.
4. **Agents** — compact status strip. Reachable / authenticated / degraded.
5. **Recently finished** — with outcome and cost.
6. **Cost and success rate** — a quiet summary bar, not hero numbers. They are
   context for the day, not the point of it.

**Principles carried from 1.0's dashboard work, which were correct:**

- A panel with nothing behind it says so. It never renders a plausible zero —
  you cannot tell a real zero from a broken binding.
- Panels bind to a **closed catalogue** of server-resolved sources. The client
  never assembles arbitrary queries.
- Aggregate in SQL, not in the browser.

**Not carried forward:** user-assembled widget grids. Home is designed. The
panels are known and fixed. Configurability here would be a worse answer to a
question we can answer well once.

---

## Naming

| Instead of | Use | Why |
|---|---|---|
| Run | **Task** | A run is what a machine does; a task is what a person asked for. Bridge 2.0 is addressed by people. |
| Manifest | **Connection** / **Agent profile** | The 1.0 word described a thing we executed. |
| Provider | **Model provider** (Settings) vs **Agent** (Agents) | These are genuinely different objects and 1.0 blurred them. |
| Knowledge | **Context** / **Memory** | Split authored from derived. |
| Deploy | **Connect** / **Enable** | You do not deploy an agent you do not own. |
| Approval | **Approval** | Unchanged. It is the right word. |

---

## Object model as the user meets it

```
Workspace
├── Agents            (an identity + an adapter + credentials + capabilities)
│   └── Teams         (a named group with routing preferences)
├── Tasks             (a request → a routing decision → a trace → a result)
│   └── Workflows     (a task graph)
├── Approvals         (a decision a task is waiting on)
├── Context           (what every agent is told)
├── Integrations      (tools and services agents reach)
└── Audit             (what happened, immutably)
```

Every object is workspace-scoped, as in 1.0.

---

## Progressive disclosure

Bridge Personal must not look like Bridge Business. The nav should grow with
use rather than presenting governance to someone with one agent:

- **Empty workspace:** Home (with a prominent "connect your first agent"),
  Agents, Settings. Nothing else.
- **After the first task:** Tasks, Activity, Approvals appear.
- **After the first team or second member:** Context, Control.
- **Business tier:** Policies, full audit export, spend controls.

The tiers in the brief are a *packaging* decision. The IA should make them a
natural extension of the same structure, not three different apps.
