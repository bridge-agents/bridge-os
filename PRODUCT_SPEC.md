# Bridge Agent OS — Product Specification

> Public brand: **Bridge**. Formal product/repo name: **Bridge Agent OS**.

## 1. What Bridge Is

Bridge is an **Agent Operating System and agentic harness generator**.

> The user describes the AI system they want. Bridge builds the agentic
> infrastructure required to operate it.

Bridge hides the complexity of agents, subagents, model providers, routing,
prompts, context, memory, tools, MCP, permissions, sandboxing, schedules,
triggers, workflows, channels, approvals, observability, dashboards,
deployment, workers, retries, failure recovery, and cost tracking — while
still exposing all of it to users who want the controls.

Bridge is usable by people who understand agents deeply, but **does not
require that knowledge**.

## 2. Core Abstraction

Bridge is not a visual workflow builder. The pipeline is:

```text
USER INTENT
     ↓
BRIDGE SPECIFICATION   (declarative, versioned "Bridge Manifest")
     ↓
AGENT ARCHITECT        (AI that designs/edits the specification)
     ↓
HARNESS COMPILER       (validates spec → deployable runtime configuration)
     ↓
AGENT RUNTIME          (long-running, queued, observable execution)
     ↓
TOOLS / MODELS / MEMORY / CHANNELS
     ↓
OBSERVABILITY + DASHBOARD
```

Bridge decides (or lets the user decide): how many agents, their
responsibilities, which model plays which role, tool access, subagent
spawning, memory retention, approval points, failure behaviour, agent
communication, triggers, and dashboard content.

**No provider lock-in.** Bridge is never hard-coded around one model vendor.

## 3. The Bridge Manifest (Bridge Agent Specification)

The single canonical, declarative representation of an agent system.

- Typed, versioned (`specVersion`), extensible, validated (Zod), migratable,
  provider-independent.
- Templates compile into it. Blank creations compile into it. AI-generated
  agents compile into it. **There is exactly one way to describe an agent.**
- Everything important is structured data so both humans and Bridge AI can
  edit it safely ("Add a research agent", "Require approval before purchases").

Schema lives in `packages/spec` (`@bridge/spec`) — see `ARCHITECTURE.md` §4.

## 4. Agent Creation Experience

Two entry paths, one output (a Manifest):

**Option A — Template.** Personal Assistant, AI Cofounder, Software Dev Team,
Research Agent, Business Operator, Sales/Marketing Team, Ecommerce Operator,
School/Study Assistant, Fitness Assistant, Personal Life OS, Custom. Templates
are intelligent starting points, never locked configurations — the user can
say "use this but add a financial research subagent and require approval
before emails" and Bridge edits the spec.

**Option B — From scratch.** Conversational guidance: what is it responsible
for, continuous or on-demand, independent actions vs. approvals, memory,
external services, communication channels. Bridge proposes an architecture;
the user inspects and modifies before deployment.

Templates are **data, not code**: a Manifest + instructions + roles + tools +
permissions + dashboard schema + recommended integrations + starter
automations. No `if template === "gym"` anywhere.

## 5. Providers

Multiple providers per workspace; different models for different roles within
one agent system (e.g. orchestrator on one vendor, coding agent on another,
cheap model for classification, separate critic). Adapter interface in
`@bridge/sdk`. Targets: OpenAI, Anthropic, Google, OpenRouter, local
OpenAI-compatible endpoints, Ollama, more later. Credentials go through a
secrets abstraction — never stored casually, never exposed to clients.

## 6. Tools & Permissions

Standardised tool adapter/plugin architecture: MCP servers, browser, shell,
filesystem, code execution, HTTP, GitHub, Gmail, Calendar, databases, search,
custom user tools, Bridge-native tools.

No tool access by default. Permission effects: **allow / deny / ask**, with
rules scoped per resource and action (read ≠ send; inspect ≠ deploy).
"Ask for dangerous actions" is expressed as rules over actions a tool declares
dangerous. Permissions are core architecture, not bolted on.

## 7. Security Model (planned from day one)

Encrypted secrets, sandboxed code execution, tool- and agent-level
permissions, workspace isolation, approval workflows, audit logs (event log),
scoped credentials, rate limits, spending limits, filesystem boundaries,
network restrictions, destructive-action confirmation, multi-tenant
isolation. Capabilities are explicit.

## 8. Runtime Requirements

Far more than request→response chat: long-running agents, background
execution, schedules, event triggers, agent-to-agent communication, subagent
spawning, retries, checkpoints, resumable tasks, cancellation, approval
pauses, concurrency, job queues, failure recovery, timeouts, task history,
cost and model-usage tracking. Closing the UI must not kill a deployed agent.

## 9. Memory (modular, not "chat history")

Separate concepts with abstract storage interfaces:

| Concept | Purpose |
|---|---|
| Conversation history | Messages between users and agents |
| Working memory | Temporary per-task context |
| Long-term memory | Persisted across sessions |
| Knowledge | Documents/files/business source material |
| Agent state | Operational state of active jobs |

## 10. Communication Modes

**Path A — Chat / Terminal.** Bridge Chat (web → desktop → mobile): agents,
conversations, files, tool activity, status indicators, approval requests,
task progress, artefacts, running jobs, commands, agent switching. Bridge
Terminal: a first-class CLI client of the same API. External channels via a
channel-adapter architecture: Telegram, Discord first; iMessage, Slack later.
Channel logic never infects the runtime.

**Path B — Custom Dashboard.** Optional. Template dashboards (Business,
Personal, School, Fitness) or built from a description. Dashboards are a
**schema/composition system** (pages → sections → widgets → data sources +
navigation + theme), serialisable, versioned, editable, AI-generatable,
validated. Never per-user hard-coded frontend source.

## 11. Branding & Design

The Bridge logo (metallic bridge mark on near-black) is the permanent
identity. Product feel: premium, minimal, technical, modern, restrained,
dark, professional — the polish class of Linear/Vercel/Raycast, but Bridge's
own language. No glowing AI gradients, glassmorphism soup, or random motion.

Users customise accent colour, background, appearance, layout, widgets, and
page structure via **design tokens** — never the Bridge logo, name, core
iconography, or underlying design language. Every dashboard immediately feels
like Bridge.

## 12. Open Core and Deployment Modes

Bridge is one product that can run in three places. The agent is the same in
all of them; only where it executes differs (ADR-0008).

### Local Desktop Mode — Bridge Community

The consumer experience. A user downloads `Bridge.dmg`, a Windows installer,
or a Linux package, opens the app, and goes through the same polished flow a
Cloud user gets: onboarding → create agent → template or blank → customise →
connect providers → tools/MCP → permissions → chat or dashboard → run.

**Bridge manages its own local runtime.** A normal user never installs
Docker, runs `docker compose`, starts Postgres or Redis, configures ports, or
opens a terminal. The database is embedded, the queue is in-process, and the
desktop app owns the runtime lifecycle. "Self-hosted" must never be read as
"the user operates infrastructure".

Because agents may need to work while the window is closed, the desktop
runtime supports background operation subject to OS limits, user settings,
permissions, battery and security — with an explicit user control for whether
Bridge may run in the background, and clear agent status: running, paused,
stopped, waiting, or offline.

### Self-Hosted Server Mode — Bridge Community

For developers, homelabs, VPSs, Linux servers and organisations. Deploy
Bridge yourself, with Docker/Compose or bare Node; desktop, mobile, web and
CLI clients connect to that instance. `docker compose up` remains a
first-class development and advanced self-hosting path — it is simply not a
consumer requirement.

### Bridge Cloud Mode — managed

Bridge operates the runtime and infrastructure: hosted runtime, managed
Postgres/queues, KMS-backed secrets, backups, remote access, managed
sandboxes, auth, teams, deployment, auto-updates, metering, billing, enhanced
observability.

Cloud sells **availability, managed infrastructure, remote execution,
backups, collaboration, sandboxes, scale and convenience** — never access to
core agent functionality withheld from Community. A local user should see an
honest prompt like "this agent only runs while your computer is available;
run it 24/7 with Bridge Cloud", not a crippled product.

### Portability

An agent's Manifest is portable across all three targets, so "Run locally"
can later become "Move to Bridge Cloud" without recreating anything, and
users can export their configuration and leave Cloud for self-hosting. Avoid
vendor lock-in in both directions.

**Runtime location ≠ model location.** A locally running Bridge agent can use
Anthropic, OpenAI, or a model on the same machine — any combination the user
configures.

### Mobile

Mobile platforms cannot offer unrestricted background execution, so the
mobile app is primarily a control surface for a runtime running elsewhere
(desktop, self-hosted server, or Cloud), plus whatever local capability the
OS genuinely allows. Bridge does not promise 24/7 on-device mobile execution.

### Local secrets

On desktop, provider credentials use secure OS facilities (platform
keychain/credential store) wherever possible. API keys are never stored as
casual plaintext in application files.

## 13. API Philosophy

The backend is a product. Web, desktop, mobile, CLI, and channel adapters all
consume the same stable Bridge APIs and typed events. Domain logic never
lives in UI components or individual clients.

## 14. MVP Definition

The first genuinely useful release lets a user:

1. Run Bridge locally (installed app, no infrastructure setup)
2. Create an account/workspace
3. Connect ≥1 model provider
4. Create an agent from template or blank
5. Add natural-language custom instructions
6. Produce a validated Bridge Manifest
7. Grant selected tools
8. Configure permissions
9. Run the agent
10. Chat with it through Bridge
11. Inspect tasks/tool activity
12. Stop/restart it
13. View basic logs and usage
14. Optionally create a simple dashboard
15. Choose where the agent runs (this device / self-hosted / Cloud)

Everything else grows from that.

## 15. UX Principle

**Expose complexity when the user wants it; never force it.** A beginner sees
"What should your agent do?"; a power user opens Models / Agents / Tools /
Memory / Context / Permissions / Runtime / Triggers / Channels / Environment /
Advanced. Both configure the *same* underlying Manifest — different
abstraction levels over one system, never two products.

## 16. Quality Bar

Serious infrastructure software, not a hackathon wrapper. Priorities:
reliability, clarity, speed, observability, security, good abstractions,
excellent developer and user experience.
