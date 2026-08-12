# ADR-0004: Redis + BullMQ for queues; runs are durable queued jobs, not resident processes

Status: accepted (2026-08-12)

## Context
Agents must run long, in the background, on schedules, survive UI closes and
worker crashes, support retries/timeouts/cancellation, and later scale
horizontally in Cloud.

## Decision
- **BullMQ on Redis** for job queues, retries with backoff, repeatable
  (cron) jobs, and delayed jobs. Boring, proven, self-hostable.
- **A run is a state machine persisted in Postgres** (`queued → running →
  waiting_approval ↔ running → succeeded | failed | cancelled`), executed by
  stateless workers pulling from queues. Checkpoints live in the DB; Redis
  holds only scheduling state. A dead worker means a resumed job, not a lost
  agent.
- Approval pauses are state (`waiting_approval`) + an event, not a blocked
  process.
- No Temporal/K8s/actor framework in the MVP: BullMQ + Postgres state covers
  the requirements; if orchestration outgrows it, runs are already
  serialized state machines — the migration path is data-compatible.

## Consequences
- "Always-running agent" = durable state + schedules, cheap at rest.
- Workers scale horizontally by running more replicas (Cloud) with zero code
  change.
- Idempotency keys are required for side-effecting steps (Phase 8 enforces).
