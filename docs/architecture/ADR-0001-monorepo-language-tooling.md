# ADR-0001: TypeScript modular monolith in a pnpm + Turborepo monorepo; Biome for lint/format

Status: accepted (2026-08-12)

## Context
Bridge spans an API, workers, multiple clients, and shared contracts. It must
be self-hostable with `docker compose up`, support long-running agents, and
scale to Cloud later — without premature microservices or Kubernetes.

## Decision
- **TypeScript everywhere**, `strict: true`, shared `tsconfig.base.json`.
  One language across contracts, API, runtime, and clients means schemas and
  types flow end to end with zero codegen.
- **Modular monolith**: two processes (`api`, `worker`) sharing packages,
  one Postgres, one Redis. Planes communicate only via DB, queues, and typed
  events, so extraction later is mechanical, not a rewrite.
- **pnpm workspaces** for package management, **Turborepo** for task
  orchestration/caching (`build`, `test`, `typecheck` respect the dependency
  graph; CI gets caching for free).
- **Biome** for linting *and* formatting: one fast tool, one config file, no
  ESLint plugin stack to maintain.
- Node ≥ 22 (LTS), ESM only.

## Consequences
- One `pnpm install`, one `turbo build` builds everything in graph order.
- Some ESLint-ecosystem rules unavailable; acceptable — Biome covers
  correctness + style, and architectural rules are enforced in review.
- Runtime portability to Bun/edge is not a goal; Node is the target.
