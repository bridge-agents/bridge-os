# ADR-0013: The agent loop is a serializable frame stack, so approvals suspend a run instead of blocking one

Status: accepted (2026-08-12)

## Context
A permission policy of `ask` has to stop a run *before* the tool executes and
wait for a human — potentially for hours. Three properties matter:

- The wait must not hold a worker, a process, or an open HTTP request.
- The run must survive an API restart, a crashed worker, and a deploy.
- It must work **anywhere in the run**, including inside a subagent. The
  shipped software-team template has a subagent with a `shell` grant, so a
  nested pause is the normal case, not an exotic one.

The Phase 3 loop was recursive. A JavaScript call stack cannot be serialized,
so a nested pause could not be represented at all — the only way to suspend
would have been to hold the promise in memory and hope nothing restarted.

Two alternatives were rejected. **Blocking in place** (await a decision inside
the loop) pins a worker per pending approval and loses everything on restart.
**Replaying from scratch** on resume re-runs earlier model calls, which costs
tokens, produces different output because models are not deterministic, and
would repeat any side effects already performed.

## Decision
The loop is an **explicit stack of frames**, each `{ agentName, messages,
pending, returnToolCallId }`. Delegation pushes a frame; a completed frame
pops and hands its answer back as the parent's tool result.

When a tool call resolves to `ask`, the loop **returns** rather than waiting:

- the offending call stays at the head of its frame's `pending` list, so there
  is no ambiguity about what is being decided;
- the whole stack, token usage and iteration count are written to
  `runs.checkpoint` (jsonb) and the run moves to `waiting_approval`;
- an `approvals` row records the tool, action and exact input for a human.

Deciding sets the run back to `queued`. An executor claims it like any other
run, rebuilds the frames from the checkpoint, applies the decision to that one
call — execute if approved, feed back a refusal with the stated reason if not
— and carries on. Steps keep numbering across the pause, so one run has one
ordered trace.

A separate rule keeps the gate meaningful: a **dangerous action is downgraded
to `ask` when only the policy default would have allowed it**
(`decideToolPermission`). Permitting something destructive has to be a rule
someone wrote, not a side effect of `default: allow`.

## Consequences
- No process holds state across the wait. Approvals can sit for days, survive
  restarts, and be decided from any client hitting the same API.
- A nested pause works: the checkpoint carries every frame, and the test suite
  covers a subagent pausing and the parent resuming afterwards.
- The frame contents are the loop's real state, so anything unserializable in
  a frame breaks resumption. Keep frames to plain data — that constraint is
  the price of durability and is worth it.
- Resume trusts the stored checkpoint. A checkpoint whose plan has since
  changed (the manifest was edited mid-pause) resumes against the *new* plan;
  the tool being approved is re-resolved by name, and a tool that no longer
  exists is treated as denied rather than executed.
