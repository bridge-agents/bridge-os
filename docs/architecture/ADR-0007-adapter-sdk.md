# ADR-0007: Providers, tools, and channels are adapters behind `@bridge/sdk` interfaces

Status: accepted (2026-08-12)

## Context
Bridge must support many model providers (different models per role in one
agent system), many tools (native, MCP, custom), and many channels
(Telegram, Discord, iMessage, Slack) without vendor logic leaking into the
runtime or provider lock-in anywhere.

## Decision
- `@bridge/sdk` defines three interfaces; everything vendor-specific lives
  in adapter implementations at the edge:
  - **Provider**: `complete()`/`stream()` over normalized messages/tool
    calls; returns normalized token usage for cost tracking. The runtime
    resolves `ModelRef { provider, model }` from the Manifest to a
    registered adapter at execution time — routing is data, not code.
  - **Tool**: name, description, Zod input schema, declared actions with
    `dangerous` flags, `execute(input, ctx)`. Ctx provides ids, logger, and
    `checkPermission` — a tool cannot bypass the permission engine. MCP
    servers are exposed as Tool implementations by a generic MCP adapter
    (Phase 4), not as a parallel concept.
  - **Channel**: `start`/`stop`/`send` + inbound handler. The runtime sees
    messages and events; it never sees a Telegram API.
- Credentials reach adapters only at execution time via the secrets
  abstraction; adapters never read env/config directly.
- A `MockProvider` ships in the SDK for tests and offline development.

## Consequences
- Adding a provider/tool/channel = one package implementing one interface +
  registration; no runtime changes.
- Contract tests written against the interfaces validate every adapter.
