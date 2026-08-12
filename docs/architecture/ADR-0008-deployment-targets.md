# ADR-0008: Three deployment targets, one portable Manifest; Docker is never a runtime prerequisite

Status: accepted (2026-08-12)

## Context
"Self-hosted" must not mean "the user installs Docker". A normal person
should download Bridge, open it, and get the same polished agent-creation
experience a Cloud user gets — while developers, homelabs and servers keep
`docker compose up`. Bridge also has to let an agent move between those
worlds later ("Run locally" → "Move to Bridge Cloud") without being recreated.

## Decision
Three **deployment targets**, one product:

| Target | Runtime location | Infrastructure the user sees |
|---|---|---|
| `local` | The user's own device, managed by the Bridge desktop app | None |
| `self-hosted` | A server the user runs | Docker/Compose, or bare Node |
| `cloud` | Bridge infrastructure | None |

- `deployment: { target, background }` is part of the Manifest and is **the
  only target-specific field**. Everything else — agents, models, tools,
  permissions, triggers, channels, dashboards — is identical across targets,
  so moving an agent is a one-field edit, enforced by a test.
- **Docker is a distribution and development choice, never a runtime
  dependency.** No core component may assume a container, a Postgres server,
  or a Redis server exists. The pieces that would have assumed it are behind
  drivers (ADR-0009 storage, ADR-0010 queue, ADR-0011 secrets), each with an
  implementation that needs nothing installed.
- The desktop app owns the lifecycle of its local runtime (start, stop,
  background operation, status) rather than asking the user to operate one.
- Runtime location and model location are independent: a `local` agent may
  call Anthropic, OpenAI, or a model on the same machine. Nothing in the
  runtime couples the two.
- Mobile is a **control plane for a runtime elsewhere** (desktop, server, or
  Cloud) plus whatever the OS permits locally. Bridge does not promise 24/7
  on-device mobile execution it cannot deliver.

## Consequences
- Cloud sells availability, managed infrastructure, collaboration and scale —
  not artificially withheld agent features. Community stays genuinely useful.
- Every new subsystem must ask "what does this do when there is no server?"
  before it ships. A feature that only works with Docker is not done.
- Export/import of manifests is portability by construction, which is also the
  anti-lock-in guarantee.
