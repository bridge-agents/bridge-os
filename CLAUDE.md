# CLAUDE.md

Guidance for Claude Code working in this repository. Read this before doing
anything else here.

## What this is

**Bridge** is an Agent Operating System and agentic harness generator: the
user describes the AI system they want, Bridge builds and runs the agentic
infrastructure for it. Open-core. Full product description in
[`README.md`](README.md) and [`PRODUCT_SPEC.md`](PRODUCT_SPEC.md); design
decisions and their reasoning in [`docs/architecture/`](docs/architecture/)
(ADR-0001 through ADR-0016 exist — read the relevant one before overturning
a decision it recorded); phase-by-phase history in
[`ROADMAP.md`](ROADMAP.md) and [`HANDOFF_TO_OPUS.md`](HANDOFF_TO_OPUS.md).

Three deployment targets share one codebase and one manifest format: local
desktop (no accounts, loopback only), self-hosted server, Bridge Cloud
(ADR-0008). Moving an agent between them is one manifest field
(`deployment.target`), not a rebuild.

## Working conventions — read before your first edit

- **Do not commit unless explicitly asked.** Working trees in this project
  often carry substantial uncommitted work across multiple sessions/agents by
  design — check `git status` before assuming a clean tree, and don't take
  "safe to commit" as the default just because tests pass.
- **Ponytail**: prefer the smallest correct change. Reuse what's already in
  the codebase over writing new abstractions. Don't add a dependency for what
  a few lines can do. Root-cause fixes over symptom patches — grep every
  caller before changing a shared function's behavior.
- **Verify claims, don't assert them.** Before reporting something fixed,
  reproduce the bug against unpatched code and confirm the fix flips it —
  this codebase has repeatedly had "fixed" bugs that weren't (see the
  workspace-default-model trap below). Run the real server, not just unit
  tests, for anything user-facing.
- **Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before calling
  something done.** All three are fast and cover the whole workspace.
- Comments in this codebase explain *why*, not *what* — match that density
  and tone when adding code. Don't add comments that restate the line below
  them.

## Commands

```bash
pnpm install
pnpm dev                              # api (:4000) + worker + web (:3000)
pnpm test                             # full suite, embedded Postgres (PGlite)
pnpm typecheck                        # strict TS, whole workspace
pnpm lint / pnpm lint:fix             # Biome
pnpm build                            # production builds
pnpm db:generate                      # SQL migration after editing schema.ts
pnpm --filter @bridge/<pkg> test      # one package
pnpm --filter @bridge/<pkg> exec vitest run src/<file>.test.ts   # one file
```

No Docker needed for normal development — the database is embedded
(PGlite/WASM Postgres) and runs in-process. `pnpm infra:up` brings up real
Postgres+Redis only if you're deliberately testing the server-mode path
(ADR-0009, ADR-0010).

## Repository layout

```text
apps/
  api/       Control plane — Hono HTTP API (auth, workspaces, agents, runs, architect)
  worker/    Data plane — hosts the run executor for server deployments
  web/       Vite + React SPA (chat, dashboards, agents, approvals, settings)
  cli/       `bridge` command line — same public API, bearer tokens
  desktop/   Electron shell — supervises the local runtime, tray, notifications
packages/
  spec/      @bridge/spec      — Manifest schema, dashboard schema, permissions, events, templates
  sdk/       @bridge/sdk       — provider / tool / channel adapter interfaces
  core/      @bridge/core      — ids, errors, env, logging, crypto, keychain
  db/        @bridge/db        — Drizzle schema, migrations, server + embedded drivers
  queue/     @bridge/queue     — JobQueue interface, BullMQ + in-process drivers
  providers/ @bridge/providers — Anthropic + OpenAI-compatible adapters, pricing
  runtime/   @bridge/runtime   — compiler, agent loop, executor, tools, MCP, sandbox, knowledge
  channels/  @bridge/channels  — Telegram + Discord adapters; inbound message → run
  commands/  @bridge/commands  — one command catalogue shared by the CLI and web "/" palette
  ui/        @bridge/ui        — design tokens, brand assets
docs/architecture/  ADRs (numbered decision records — read before relitigating one)
```

## Architecture, in one page

- **The Manifest is the single definition of an agent.** Everything else
  (automations, dashboards, deployed state) is *projected* from it — never a
  second source of truth. Edits go through `@bridge/spec`'s Zod schema
  (`parseManifest`/`safeParseManifest`); nothing writes an unvalidated
  manifest to the `agents` table.
- **One Postgres dialect, two drivers**: `postgres.js` for a real server,
  PGlite (WASM) embedded for desktop and tests. Same schema, same migrations
  (ADR-0009). **PGlite is a single connection** — querying the outer `db`
  handle while inside a `db.transaction()` deadlocks. This has bitten this
  codebase more than once; if you're touching transactional code, check for
  nested queries on the outer handle.
- **Runs are claimed from the database** with `FOR UPDATE SKIP LOCKED`
  (ADR-0012), not pulled from a job queue — that's what lets desktop (no
  Redis) and server (BullMQ) share one execution path. The agent loop is a
  serializable frame stack so a run can pause for human approval and resume
  in a different process (ADR-0013).
- **Model resolution chain**, in priority order: explicit choice on the
  call → automation's own model → **workspace default model** →
  agent manifest's `models.default`. **This has been the root cause of
  multiple "fetch failed" / "provider not connected" bugs**: any new code
  path that resolves a model (a tool, a background job, an automation) must
  walk this chain, not just read the manifest — the manifest's default
  provider is frequently one the workspace never actually connected.
- **Tool sandbox** (`packages/runtime/src/tools/sandbox.ts`): filesystem
  confined to the agent's own directory unless explicitly widened via
  `runtime.sandbox.allowedPaths` (per-manifest) or the workspace's
  `allowedPaths` (per-workspace, unioned in); network `restricted` mode
  resolves DNS and rejects private/loopback ranges. Every destructive or
  boundary-crossing action either matches an explicit `allow` permission
  rule or pauses for human approval — never a permissive default.
- **Secrets**: AES-256-GCM at rest, one master key from the OS credential
  store on desktop (Keychain/libsecret/DPAPI, ADR-0016), operator-supplied
  `BRIDGE_SECRET_KEY` on a server. Never log or return plaintext credentials;
  the API only ever returns a masked hint.
- **Streaming**: the run bus (`packages/runtime/src/bus.ts`) fans out deltas
  in-process; the SSE endpoint (`apps/api/src/stream.ts`) subscribes to it
  and falls back to a slow poll only when nothing is watching. Deltas are
  batched before being written to `run_stream_events` — one row per token
  was measured to contend badly with PGlite's single connection.
- **Knowledge**: a background `KnowledgeConsolidator`
  (`packages/runtime/src/knowledge.ts`) reads the per-turn journal
  (`memory_entries`) in batches — not after every message — and folds it
  into a graph (`knowledge_nodes`/`knowledge_edges`) with confidence and
  merge-on-title semantics. Every agent also gets four generated files
  (`IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`) written into its own
  sandboxed directory on first run and never overwritten after
  (`packages/runtime/src/charter.ts`) — they're loaded into every run's
  system context above memory.
- **Image generation is intrinsic, not a grantable tool**: any agent whose
  workspace has an image-capable provider connected can draw, with no
  approval prompt (drawing changes nothing on disk). Don't reintroduce it as
  a `tools[]` entry — that was tried and reverted because it required both a
  manual grant and triggered spurious approval prompts.

## Testing conventions

- Tests spin up a real (embedded) database per test file — `createDb` +
  `.migrate()` in `beforeEach`, no mocking the DB layer. Live-verify
  API/runtime changes against `apps/api/src/testing.ts`'s `createTestApp()`
  harness, not just unit-level assertions.
- When claiming a regression test actually catches the bug: revert the fix
  locally, run the test, confirm it fails, then reapply. This has caught
  false "passing" tests before.
- `packages/runtime/src/executor.test.ts` and `packages/runtime/src/*.test.ts`
  are the densest source of "how this system is actually supposed to behave"
  — read the nearby tests before changing executor/loop/knowledge behavior.

## Known sharp edges

- `apps/web` frontend work is governed by additional rules in
  [`AGENTS.md`](AGENTS.md) — shadcn/ui only, assistant-ui for chat, no
  landing-page-style decoration in product routes. Read it before touching
  `apps/web`.
- The desktop build bundles the API with esbuild (`apps/api/build.mjs`);
  pnpm's symlinked `node_modules` does not survive that bundling as-is for
  some packages (pglite, pino) — check the build script's `external` list
  before assuming a new dependency will "just work" in the packaged app.
- Local mode (`BRIDGE_LOCAL_MODE`, defaults on for an embedded database)
  provisions one owner account automatically and binds loopback-only — it is
  deliberately tied to the embedded DB so a server pointed at real Postgres
  never silently drops authentication (ADR-0014).
