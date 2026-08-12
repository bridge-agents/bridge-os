# ADR-0012: Runs are claimed from the database, not pushed through the queue

Status: accepted (2026-08-12) — refines [ADR-0004](ADR-0004-redis-bullmq-runtime.md) and [ADR-0010](ADR-0010-queue-drivers.md)

## Context
ADR-0004 made a run durable state in Postgres and treated the queue as
dispatch. ADR-0010 then added an in-process queue driver so a desktop install
needs no Redis. Implementing the runtime exposed a gap in that combination:

- The in-process queue only reaches workers **inside the same process**. With
  the API and worker as separate processes, an enqueue from the API would
  never arrive.
- The embedded database (ADR-0009) is single-process anyway, so on desktop the
  API and the runtime *must* share one process — and on a server they must not
  be forced to.

Keeping both a queue push and durable state also meant two mechanisms that
could disagree about what work exists.

## Decision
**Runs are claimed directly from the `runs` table**, not pushed through
`@bridge/queue`:

```sql
update runs set status = 'running', heartbeat_at = now(), attempt = attempt + 1
where id = (select id from runs where status = 'queued'
            order by queued_at limit 1 for update skip locked)
returning …
```

- `FOR UPDATE SKIP LOCKED` makes the claim atomic, so any number of workers
  can poll the same table without racing for the same run.
- Executors refresh `heartbeat_at` while working. A run whose heartbeat goes
  stale is requeued (or failed once `attempt` exceeds the limit), which is how
  a crashed worker's work is recovered.
- `cancel_requested` is a column the executor checks at step boundaries, so
  cancellation needs no out-of-band signal either.

`@bridge/queue` remains the mechanism for **scheduled and event-driven jobs**
(Phase 8), where push semantics and cron support genuinely earn their keep.

**Process topology follows from the database driver.** With an embedded
database the API hosts the executor in-process (the desktop shape); with a
server database `apps/worker` runs it separately and the worker exits with an
explanation if pointed at an embedded URL. `BRIDGE_EMBEDDED_RUNTIME=1|0`
overrides for anyone who wants a single-process server.

## Consequences
- One mechanism, one source of truth: if a run row says `queued`, it will be
  picked up — there is no queue entry to lose or double-deliver.
- Crash recovery and cancellation come from the same rows rather than needing
  Redis features, so both work identically on a laptop and a fleet.
- Pickup latency is bounded by the poll interval (1s default) instead of being
  push-immediate. That is irrelevant for runs measured in seconds to minutes;
  if it ever matters, a queue push can wake the poller without changing where
  the truth lives.
- Polling costs one indexed query per interval per worker. `runs_status_idx`
  covers it; revisit if worker counts grow large.
