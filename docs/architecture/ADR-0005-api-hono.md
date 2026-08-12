# ADR-0005: Hono on Node for the API; the backend is a product with one public API

Status: accepted (2026-08-12)

## Context
Web, desktop, mobile, CLI, and channel adapters must all consume the same
stable API (API-first requirement). Needs: typed validation at the boundary,
SSE streaming, WebSockets later, small footprint in Docker.

## Decision
- **Hono** (`@hono/node-server`): tiny, TypeScript-first, Zod validation
  middleware that reuses `@bridge/spec` schemas, built-in SSE helpers, and a
  fetch-based test client (`app.request()`) that needs no listening socket.
  Chosen over Fastify (heavier plugin ecosystem we don't need; weaker type
  inference) and Next API routes (couples backend to the web client, which
  the API-first rule forbids).
- Route versioning under `/v1/*`. Consistent error envelope
  `{ error: { code, message, details? } }` from a single error handler
  mapping `BridgeError` codes to HTTP statuses.
- Request logging via pino with request ids; no business logic in routes —
  routes validate, call domain modules, serialize.
- Realtime: SSE first (chat streaming, events), WebSockets only if a feature
  demands bidirectional (terminal attach may later).

## Consequences
- CLI/desktop/mobile are true first-class clients from day one.
- If Hono ever binds us, routes are thin enough that swapping frameworks is
  mechanical.
