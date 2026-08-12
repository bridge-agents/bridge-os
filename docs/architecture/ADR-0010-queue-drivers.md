# ADR-0010: `JobQueue` interface with BullMQ and in-process drivers

Status: accepted (2026-08-12) — amends [ADR-0004](ADR-0004-redis-bullmq-runtime.md)

## Context
ADR-0004 chose BullMQ on Redis. ADR-0008 forbids requiring Redis on a user's
laptop. Bridge still needs enqueue, scheduled/repeating jobs, concurrency
limits and failure reporting in both worlds.

## Decision
One interface in `@bridge/queue` — `enqueue`, `schedule`, `process`, `close`
— with two implementations selected by configuration:

- **BullMqQueue** when `REDIS_URL` is set: servers and Cloud, where multiple
  worker processes, cross-process visibility and retry backoff matter.
- **LocalQueue** otherwise: an in-process FIFO with a concurrency cap and
  interval-based schedules. One desktop install is one process.

This is only safe because of the ADR-0004 invariant it inherits: **a run is
durable state in Postgres, and the queue is dispatch, not the record**. A lost
in-memory entry is recoverable by rescanning for unfinished runs, which is
also how a crashed server worker recovers.

The local driver's scheduled timers are deliberately *referenced*, not
`unref`'d: a scheduled agent is precisely the reason a local worker process
should stay alive. (Getting this backwards made the worker exit immediately
on startup; there is a regression test.)

## Consequences
- The runtime and every job author write to one interface and never learn
  which driver is active.
- Local background operation is bounded by the desktop app's lifecycle and OS
  policy, which is the honest limit to surface in the UI ("this agent runs
  while your computer is available") and the thing Cloud upgrades.
- Multi-process fan-out, priorities and delayed retries stay BullMQ features.
  If the local driver ever needs them, it grows a Postgres-backed
  implementation behind the same interface — not a new interface.
