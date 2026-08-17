import { id, type Logger } from "@bridge/core";
import { agents, appendEvent, automations, type Db, events, runs, workspaces } from "@bridge/db";
import {
  type EventTrigger,
  type Manifest,
  parseManifest,
  type ScheduleTrigger,
  safeParseManifest,
} from "@bridge/spec";
import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { dailyBudgetExceeded } from "./budget.js";
import { createConversation, enqueueRun } from "./executor.js";
import { kindOf, loopEnded, nextFireTime } from "./schedule.js";

/**
 * The automation runner: the thing that makes a schedule actually happen.
 *
 * It is a poller over the database, not a timer wheel, for the same reason
 * runs are claimed from the database (ADR-0012): a desktop that was asleep,
 * a process that crashed, and a second instance that started are all the
 * same situation, and only durable state answers them consistently. A timer
 * in memory forgets everything the moment the lid closes.
 *
 * Firing is a compare-and-swap on `next_run_at` inside a transaction with
 * the run insert. Two runners racing produce one run, and a crash produces
 * either both or neither — never a fired schedule with no run, and never two
 * runs for one tick.
 */
export interface AutomationRunnerOptions {
  db: Db;
  logger: Logger;
  /** How often to look for work. */
  pollMs?: number;
  /** How often to re-read manifests for trigger changes. */
  syncMs?: number;
  /** Injected in tests so a schedule's clock can be moved. */
  now?: () => Date;
}

/** Order-independent serialization, for comparing a stored spec to a fresh one. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** A row plus the parsed trigger it came from. */
interface Due {
  id: string;
  workspaceId: string;
  agentId: string;
  name: string;
  kind: string;
  spec: unknown;
  nextRunAt: Date | null;
  cursorSeq: number | null;
  lastRunId: string | null;
  runsCount: number;
  consecutiveFailures: number;
}

export class AutomationRunner {
  private timer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: AutomationRunnerOptions) {}

  private get now(): Date {
    return this.options.now?.() ?? new Date();
  }

  start(): void {
    const poll = this.options.pollMs ?? 5_000;
    const sync = this.options.syncMs ?? 60_000;
    this.timer = setInterval(() => void this.safeTick(), poll);
    this.syncTimer = setInterval(() => void this.safeSync(), sync);
    void this.safeSync().then(() => this.safeTick());
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    clearInterval(this.syncTimer);
  }

  private async safeTick(): Promise<void> {
    // Overlapping passes would double-count failures and fight over claims.
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (err) {
      this.options.logger.error({ err }, "automation tick failed");
    } finally {
      this.running = false;
    }
  }

  private async safeSync(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.options.logger.error({ err }, "automation sync failed");
    }
  }

  /**
   * Each workspace's default timezone, cached for one pass.
   *
   * A cron schedule with no zone of its own means "where the user is", and
   * that answer lives on the workspace — so it has to be read before any
   * next-fire time is computed, not assumed to be UTC.
   */
  private async zones(): Promise<Map<string, string>> {
    const rows = await this.options.db
      .select({ id: workspaces.id, timezone: workspaces.timezone })
      .from(workspaces);
    return new Map(rows.map((row) => [row.id, row.timezone ?? "UTC"]));
  }

  /**
   * The workspace's default model, used when a trigger does not name one.
   *
   * Without this an automation falls all the way back to whatever the
   * agent's manifest says — which is how a schedule ends up calling a local
   * endpoint nobody is running while chat, which always sends an explicit
   * model, works fine.
   */
  private async workspaceDefaults(
    workspaceId: string,
  ): Promise<{ model?: { provider: string; model: string }; reasoningEffort?: string }> {
    const [row] = await this.options.db
      .select({ model: workspaces.defaultModel, reasoning: workspaces.defaultReasoning })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return {
      ...(row?.model ? { model: row.model } : {}),
      ...(row?.reasoning ? { reasoningEffort: row.reasoning } : {}),
    };
  }

  /**
   * Project every deployed agent's triggers into rows, and retire the rows
   * of triggers that are gone.
   *
   * Reconciliation rather than events on deploy: it is idempotent, it heals
   * a row someone deleted by hand, and it is how an agent that was already
   * deployed before this feature existed gets its schedules.
   */
  async sync(): Promise<void> {
    const { db } = this.options;
    const zones = await this.zones();
    const deployed = await db
      .select({
        id: agents.id,
        workspaceId: agents.workspaceId,
        manifest: agents.manifest,
      })
      .from(agents)
      .where(eq(agents.status, "deployed"));

    const live = new Set<string>();

    for (const agent of deployed) {
      const parsed = safeParseManifest(agent.manifest);
      // An unparseable manifest is the agent's problem, not the scheduler's;
      // it will already be visible everywhere else.
      if (!parsed.success) continue;

      const zone = zones.get(agent.workspaceId) ?? "UTC";
      for (const trigger of parsed.data.triggers.schedules) {
        live.add(`${agent.id}:${trigger.name}`);
        await this.upsert(
          agent.workspaceId,
          agent.id,
          trigger.name,
          kindOf(trigger),
          trigger,
          zone,
        );
      }
      for (const trigger of parsed.data.triggers.events) {
        live.add(`${agent.id}:${trigger.name}`);
        await this.upsert(agent.workspaceId, agent.id, trigger.name, "event", trigger, zone);
      }
    }

    // Triggers removed from a manifest, or agents no longer deployed. Rows
    // are deleted rather than paused: the manifest is the declaration, and a
    // trigger that is not in it does not exist.
    const rows = await db
      .select({ id: automations.id, agentId: automations.agentId, name: automations.name })
      .from(automations);
    const stale = rows
      .filter((row) => !live.has(`${row.agentId}:${row.name}`))
      .map((row) => row.id);
    if (stale.length) await db.delete(automations).where(inArray(automations.id, stale));
  }

  /**
   * Where the log has reached. A new event automation starts here, so
   * turning one on reacts to what happens next rather than replaying
   * everything that already did.
   */
  private async latestEventSeq(workspaceId: string): Promise<number> {
    const [row] = await this.options.db
      .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
      .from(events)
      .where(eq(events.workspaceId, workspaceId));
    return Number(row?.seq ?? 0);
  }

  private async upsert(
    workspaceId: string,
    agentId: string,
    name: string,
    kind: "cron" | "interval" | "event",
    trigger: ScheduleTrigger | EventTrigger,
    zone: string,
  ): Promise<void> {
    const { db } = this.options;
    const now = this.now;

    const [existing] = await db
      .select({
        id: automations.id,
        spec: automations.spec,
        status: automations.status,
        nextRunAt: automations.nextRunAt,
      })
      .from(automations)
      .where(and(eq(automations.agentId, agentId), eq(automations.name, name)));

    const disabledByAuthor = !trigger.enabled;

    if (!existing) {
      await db.insert(automations).values({
        id: id("aut"),
        workspaceId,
        agentId,
        name,
        kind,
        spec: trigger,
        status: disabledByAuthor ? "paused" : "active",
        /**
         * An event automation starts at the end of the log, not the
         * beginning — turning one on must not replay last week.
         */
        cursorSeq: kind === "event" ? await this.latestEventSeq(workspaceId) : null,
        nextRunAt: kind === "event" ? null : nextFireTime(trigger as ScheduleTrigger, now, zone),
      });
      return;
    }

    // Key order has to be normalised before comparing: jsonb does not store
    // it, so a round trip reorders the object and a naive compare reports
    // every sync as a change — which would push the next run further out on
    // every pass and mean a schedule that never fires.
    if (canonical(existing.spec) === canonical(trigger)) return;

    /**
     * The definition changed, so any schedule computed from the old one is
     * meaningless — recompute it. Editing a schedule is also how someone
     * revives one that stopped, so a changed spec clears the ending.
     */
    await db
      .update(automations)
      .set({
        kind,
        spec: trigger,
        status: disabledByAuthor ? "paused" : "active",
        statusReason: null,
        consecutiveFailures: 0,
        nextRunAt: kind === "event" ? null : nextFireTime(trigger as ScheduleTrigger, now, zone),
        updatedAt: now,
      })
      .where(eq(automations.id, existing.id));
  }

  /** One pass. Returns how many runs it started, which tests assert on. */
  async tick(): Promise<number> {
    await this.settleOutcomes();

    const zones = await this.zones();
    let started = 0;
    for (const row of await this.due()) {
      started += (await this.fire(row, zones.get(row.workspaceId) ?? "UTC")) ? 1 : 0;
    }
    return started;
  }

  /**
   * Read the result of each automation's last run.
   *
   * The runner does not watch runs execute — it asks afterwards, which keeps
   * it decoupled from the executor and correct across a restart. This is
   * what feeds the consecutive-failure guard.
   */
  private async settleOutcomes(): Promise<void> {
    const { db } = this.options;
    const pending = await db
      .select({
        id: automations.id,
        lastRunId: automations.lastRunId,
        spec: automations.spec,
        consecutiveFailures: automations.consecutiveFailures,
      })
      .from(automations)
      .where(and(isNotNull(automations.lastRunId), eq(automations.status, "active")));
    if (!pending.length) return;

    const finished = await db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(
        and(
          inArray(
            runs.id,
            pending.map((row) => row.lastRunId as string),
          ),
          inArray(runs.status, ["succeeded", "failed", "cancelled"]),
        ),
      );
    const outcome = new Map(finished.map((run) => [run.id, run.status]));

    for (const row of pending) {
      const status = outcome.get(row.lastRunId as string);
      if (!status) continue;

      const failures = status === "succeeded" ? 0 : row.consecutiveFailures + 1;
      await db
        .update(automations)
        .set({ lastRunId: null, consecutiveFailures: failures })
        .where(eq(automations.id, row.id));
    }
  }

  /** Automations that want to fire now. */
  private async due(): Promise<Due[]> {
    const now = this.now;
    return this.options.db
      .select({
        id: automations.id,
        workspaceId: automations.workspaceId,
        agentId: automations.agentId,
        name: automations.name,
        kind: automations.kind,
        spec: automations.spec,
        nextRunAt: automations.nextRunAt,
        cursorSeq: automations.cursorSeq,
        lastRunId: automations.lastRunId,
        runsCount: automations.runsCount,
        consecutiveFailures: automations.consecutiveFailures,
      })
      .from(automations)
      .where(
        and(
          eq(automations.status, "active"),
          or(lte(automations.nextRunAt, now), eq(automations.kind, "event")),
        ),
      )
      .orderBy(asc(automations.nextRunAt))
      .limit(100);
  }

  private async fire(row: Due, zone: string): Promise<boolean> {
    const { db, logger } = this.options;
    const now = this.now;
    const trigger = row.spec as ScheduleTrigger & EventTrigger;

    // A previous run that has not finished. Automations do not stack: if the
    // hourly job takes ninety minutes, you want one of it, not two.
    if (row.lastRunId) return false;

    const ended = loopEnded(
      trigger,
      { runsCount: row.runsCount, consecutiveFailures: row.consecutiveFailures },
      now,
    );
    if (ended) {
      await this.finish(row, ended.status, ended.reason);
      return false;
    }

    const [agent] = await db
      .select({ manifest: agents.manifest, status: agents.status, name: agents.name })
      .from(agents)
      .where(eq(agents.id, row.agentId));
    // Undeploying an agent stops its automations without deleting them.
    if (agent?.status !== "deployed") return false;

    let manifest: Manifest;
    try {
      manifest = parseManifest(agent.manifest);
    } catch {
      return false;
    }

    /**
     * A budget stops the firing but never the automation: the allowance
     * resets tomorrow, and disabling a schedule because it was briefly over
     * would mean a quiet failure the user has to notice and undo.
     */
    const overBudget = await dailyBudgetExceeded(
      db,
      row.workspaceId,
      row.agentId,
      manifest.runtime.limits,
    );
    if (overBudget) {
      await db
        .update(automations)
        .set({
          statusReason: `skipped: ${overBudget}`,
          nextRunAt: row.kind === "event" ? null : nextFireTime(trigger, now, zone),
          updatedAt: now,
        })
        .where(eq(automations.id, row.id));
      logger.warn({ automation: row.name, reason: overBudget }, "automation skipped");
      return false;
    }

    return row.kind === "event"
      ? this.fireEvent(row, trigger, manifest)
      : this.fireSchedule(row, trigger, manifest, zone);
  }

  private async fireSchedule(
    row: Due,
    trigger: ScheduleTrigger,
    manifest: Manifest,
    zone: string,
  ): Promise<boolean> {
    const { db, logger } = this.options;
    const now = this.now;
    const next = nextFireTime(trigger, now, zone);
    const defaults = await this.workspaceDefaults(row.workspaceId);

    const runId = await db.transaction(async (tx) => {
      /**
       * The claim. `next_run_at` must still be what we read, so of two
       * runners exactly one proceeds — and because the run insert shares
       * this transaction, a crash cannot leave a schedule marked fired with
       * nothing to show for it.
       */
      const claimed = await tx
        .update(automations)
        .set({
          nextRunAt: next,
          lastRunAt: now,
          runsCount: sql`${automations.runsCount} + 1`,
          statusReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(automations.id, row.id),
            row.nextRunAt
              ? eq(automations.nextRunAt, row.nextRunAt)
              : sql`${automations.nextRunAt} is null`,
          ),
        )
        .returning({ id: automations.id });
      if (!claimed.length) return undefined;

      const created = await this.startRun(
        tx as unknown as Db,
        row,
        trigger,
        manifest,
        {
          text: trigger.input ?? `Scheduled run: ${row.name}`,
          title: `${row.name} · ${now.toISOString().slice(0, 16).replace("T", " ")}`,
        },
        defaults,
      );
      await tx.update(automations).set({ lastRunId: created }).where(eq(automations.id, row.id));
      return created;
    });

    if (!runId) return false;
    logger.info({ automation: row.name, runId, next: next.toISOString() }, "automation fired");
    await appendEvent(db, "automation.fired", {
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      runId,
      data: { automation: row.name, kind: row.kind },
    });
    return true;
  }

  /**
   * Deliver one event to its subscriber.
   *
   * One per pass on purpose: a burst of events becomes a queue of runs paced
   * by the poll interval rather than fifty agents starting at once.
   */
  private async fireEvent(row: Due, trigger: EventTrigger, manifest: Manifest): Promise<boolean> {
    const { db, logger } = this.options;
    const cursor = row.cursorSeq ?? 0;
    // Read before the transaction: the embedded database is one connection.
    const defaults = await this.workspaceDefaults(row.workspaceId);

    const [event] = await db
      .select({
        id: events.id,
        seq: events.seq,
        type: events.type,
        data: events.data,
        runId: events.runId,
      })
      .from(events)
      .where(
        and(
          eq(events.workspaceId, row.workspaceId),
          eq(events.type, trigger.event),
          gt(events.seq, cursor),
        ),
      )
      .orderBy(asc(events.seq))
      .limit(1);
    if (!event) return false;

    /**
     * The cycle guard: an automation-started run emits events, and if those
     * events could start more runs the loop never ends. So automated runs do
     * not trigger event automations. It rules out chaining, which is the
     * price of ruling out runaway.
     */
    if (event.runId && (await this.isAutomated(event.runId))) {
      await db.update(automations).set({ cursorSeq: event.seq }).where(eq(automations.id, row.id));
      return false;
    }

    const runId = await db.transaction(async (tx) => {
      const claimed = await tx
        .update(automations)
        .set({
          cursorSeq: event.seq,
          lastRunAt: this.now,
          runsCount: sql`${automations.runsCount} + 1`,
          statusReason: null,
          updatedAt: this.now,
        })
        .where(
          and(
            eq(automations.id, row.id),
            row.cursorSeq === null
              ? sql`${automations.cursorSeq} is null`
              : eq(automations.cursorSeq, row.cursorSeq),
          ),
        )
        .returning({ id: automations.id });
      if (!claimed.length) return undefined;

      const context = JSON.stringify(event.data);
      const created = await this.startRun(
        tx as unknown as Db,
        row,
        trigger,
        manifest,
        {
          text: `${trigger.input ?? `Handle the ${event.type} event.`}\n\nEvent: ${event.type}\n${context}`,
          title: `${row.name} · ${event.type}`,
        },
        defaults,
      );
      await tx.update(automations).set({ lastRunId: created }).where(eq(automations.id, row.id));
      return created;
    });

    if (!runId) return false;
    logger.info({ automation: row.name, event: event.type, runId }, "automation fired on event");
    await appendEvent(db, "automation.fired", {
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      runId,
      data: { automation: row.name, kind: "event", event: event.type },
    });
    return true;
  }

  private async isAutomated(runId: string): Promise<boolean> {
    const [run] = await this.options.db
      .select({ trigger: runs.trigger })
      .from(runs)
      .where(eq(runs.id, runId));
    return run?.trigger === "schedule" || run?.trigger === "event";
  }

  /**
   * Note the `defaults` parameter: it is read *before* the transaction that
   * calls this opens. The embedded database is a single connection, so a
   * query issued on the outer handle while a transaction is in flight
   * deadlocks — the reason this is passed rather than looked up here.
   */
  private async startRun(
    db: Db,
    row: Due,
    trigger: ScheduleTrigger | EventTrigger,
    manifest: Manifest,
    input: { text: string; title: string },
    defaults: { model?: { provider: string; model: string }; reasoningEffort?: string },
  ): Promise<string> {
    /**
     * A conversation per firing, not one long thread: two runs of a nightly
     * report have nothing to say to each other, and a thread that grows
     * forever would eventually be the whole context window.
     */
    const conversationId = await createConversation(db, {
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      title: input.title.slice(0, 80),
    });

    // A trigger may name a subagent; the run still belongs to the agent, and
    // naming it in the task is how the entry agent knows to delegate.
    const target =
      trigger.agent && trigger.agent !== manifest.entryAgent ? trigger.agent : undefined;

    // The trigger's own choice wins; otherwise the workspace's.
    const model = trigger.model ?? defaults.model;
    const reasoningEffort = (trigger.reasoningEffort ?? defaults.reasoningEffort) as
      | "none"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max"
      | "ultra"
      | undefined;

    return enqueueRun(db, {
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      conversationId,
      text: target ? `Delegate this to the "${target}" agent.\n\n${input.text}` : input.text,
      trigger: row.kind === "event" ? "event" : "schedule",
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  private async finish(row: Due, status: "completed" | "disabled", reason: string): Promise<void> {
    await this.options.db
      .update(automations)
      .set({ status, statusReason: reason, nextRunAt: null, updatedAt: this.now })
      .where(eq(automations.id, row.id));

    this.options.logger.info({ automation: row.name, status, reason }, "automation ended");
    await appendEvent(this.options.db, "automation.ended", {
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      data: { automation: row.name, status, reason },
    });
  }
}
