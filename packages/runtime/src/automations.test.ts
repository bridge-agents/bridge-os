import { createLogger, newAgentId, newWorkspaceId } from "@bridge/core";
import {
  agents,
  appendEvent,
  automations,
  createDb,
  type DbHandle,
  runs,
  workspaces,
} from "@bridge/db";
import { type Manifest, personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationRunner } from "./automations.js";

/**
 * The automation runner against a real database.
 *
 * The behaviour worth testing is not "a timer fired" — it is what happens
 * around the firing: two runners racing, a laptop that was asleep, a
 * schedule whose runs keep failing, an event that would trigger itself. All
 * of those are database states, so all of them are set up as database rows.
 */
let handle: DbHandle;
let workspaceId: string;
let agentId: string;
let clock: Date;

const logger = createLogger("test");
logger.level = "silent";

const manifest = (triggers: Partial<Manifest["triggers"]> = {}): Manifest => ({
  ...personalAssistantTemplate.manifest,
  specVersion: SPEC_VERSION,
  triggers: { schedules: [], events: [], ...triggers },
});

function runner(overrides: Record<string, unknown> = {}) {
  return new AutomationRunner({
    db: handle.db,
    logger,
    now: () => clock,
    ...overrides,
  });
}

async function deploy(m: Manifest, status = "deployed"): Promise<void> {
  await handle.db.update(agents).set({ manifest: m, status }).where(eq(agents.id, agentId));
}

const schedule = (fields: Record<string, unknown>) => ({
  name: "nightly",
  timezone: "UTC",
  enabled: true,
  loop: { maxConsecutiveFailures: 5 },
  ...fields,
});

const listRuns = () =>
  handle.db
    .select({ id: runs.id, trigger: runs.trigger, input: runs.input })
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId));

const automation = async () => {
  const [row] = await handle.db.select().from(automations).where(eq(automations.agentId, agentId));
  return row;
};

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();
  clock = new Date("2026-08-14T10:00:00Z");

  workspaceId = newWorkspaceId();
  agentId = newAgentId();
  await handle.db.insert(workspaces).values({ id: workspaceId, name: "Test" });
  await handle.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: "Assistant",
    slug: "assistant",
    specVersion: SPEC_VERSION,
    manifest: manifest(),
    status: "deployed",
  });
});

afterEach(async () => {
  await handle.close();
});

describe("projecting manifests into automations", () => {
  it("creates a row for each trigger on a deployed agent", async () => {
    await deploy(manifest({ schedules: [schedule({ cron: "0 9 * * *" })] }));
    await runner().sync();

    const row = await automation();
    expect(row?.kind).toBe("cron");
    expect(row?.status).toBe("active");
    // Scheduled for the next 9am, not for now.
    expect(row?.nextRunAt?.toISOString()).toBe("2026-08-15T09:00:00.000Z");
  });

  it("ignores agents that are not deployed", async () => {
    await deploy(manifest({ schedules: [schedule({ every: "5m" })] }), "draft");
    await runner().sync();

    expect(await automation()).toBeUndefined();
  });

  it("removes a trigger deleted from the manifest", async () => {
    await deploy(manifest({ schedules: [schedule({ every: "5m" })] }));
    await runner().sync();
    expect(await automation()).toBeDefined();

    await deploy(manifest());
    await runner().sync();
    expect(await automation()).toBeUndefined();
  });

  it("keeps its position when the manifest has not changed", async () => {
    await deploy(manifest({ schedules: [schedule({ every: "1h" })] }));
    await runner().sync();
    const first = await automation();

    clock = new Date("2026-08-14T10:30:00Z");
    await runner().sync();

    // Re-syncing must not push the next run out by another hour every minute.
    expect((await automation())?.nextRunAt?.toISOString()).toBe(first?.nextRunAt?.toISOString());
  });

  it("recomputes when the schedule itself changes", async () => {
    await deploy(manifest({ schedules: [schedule({ every: "1h" })] }));
    await runner().sync();

    await deploy(manifest({ schedules: [schedule({ every: "5m" })] }));
    await runner().sync();

    expect((await automation())?.nextRunAt?.toISOString()).toBe("2026-08-14T10:05:00.000Z");
  });

  it("starts an event automation from now, not from the beginning of history", async () => {
    await appendEvent(handle.db, "run.failed", { workspaceId, agentId });
    await deploy(
      manifest({
        events: [
          {
            name: "on-fail",
            event: "run.failed",
            enabled: true,
            loop: { maxConsecutiveFailures: 5 },
          },
        ],
      }),
    );
    await runner().sync();

    // Turning on an automation must not replay everything that already
    // happened — that would be a stampede on the first tick.
    await runner().tick();
    expect(await listRuns()).toHaveLength(0);
  });

  it("respects a trigger the author disabled", async () => {
    await deploy(manifest({ schedules: [schedule({ every: "5m", enabled: false })] }));
    await runner().sync();

    expect((await automation())?.status).toBe("paused");
    expect(await runner().tick()).toBe(0);
  });
});

describe("firing a schedule", () => {
  beforeEach(async () => {
    await deploy(manifest({ schedules: [schedule({ every: "1h", input: "Summarise the day" })] }));
    await runner().sync();
  });

  it("does nothing before it is due", async () => {
    expect(await runner().tick()).toBe(0);
    expect(await listRuns()).toHaveLength(0);
  });

  it("starts a run when it comes due, marked as scheduled", async () => {
    clock = new Date("2026-08-14T11:00:00Z");
    expect(await runner().tick()).toBe(1);

    const [run] = await listRuns();
    expect(run?.trigger).toBe("schedule");
    expect((run?.input as { text: string } | undefined)?.text).toBe("Summarise the day");
  });

  it("moves to the next slot rather than firing again immediately", async () => {
    clock = new Date("2026-08-14T11:00:00Z");
    await runner().tick();

    expect((await automation())?.nextRunAt?.toISOString()).toBe("2026-08-14T12:00:00.000Z");
    expect(await runner().tick()).toBe(0);
  });

  it("fires once for a window that was missed entirely", async () => {
    // The laptop was shut for six hours. Six runs at once is a surprise
    // bill; one run and back on rhythm is what a person means by "missed".
    clock = new Date("2026-08-14T17:00:00Z");
    expect(await runner().tick()).toBe(1);
    expect(await listRuns()).toHaveLength(1);
  });

  it("does not start a second run while the first is still going", async () => {
    clock = new Date("2026-08-14T11:00:00Z");
    await runner().tick();

    clock = new Date("2026-08-14T12:00:00Z");
    expect(await runner().tick()).toBe(0);
    expect(await listRuns()).toHaveLength(1);
  });

  it("resumes once the previous run finishes", async () => {
    clock = new Date("2026-08-14T11:00:00Z");
    await runner().tick();
    const [first] = await listRuns();
    await handle.db
      .update(runs)
      .set({ status: "succeeded" })
      .where(eq(runs.id, first?.id ?? ""));

    clock = new Date("2026-08-14T12:00:00Z");
    expect(await runner().tick()).toBe(1);
  });

  it("gives two runners racing exactly one run", async () => {
    clock = new Date("2026-08-14T11:00:00Z");
    const results = await Promise.all([runner().tick(), runner().tick()]);

    // The claim is a compare-and-swap, so the loser fires nothing.
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await listRuns()).toHaveLength(1);
  });

  it("stops when the agent is undeployed", async () => {
    await handle.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agentId));
    clock = new Date("2026-08-14T11:00:00Z");

    expect(await runner().tick()).toBe(0);
  });
});

describe("loops that end", () => {
  it("completes after the requested number of runs", async () => {
    await deploy(
      manifest({
        schedules: [schedule({ every: "1m", loop: { maxRuns: 2, maxConsecutiveFailures: 5 } })],
      }),
    );
    await runner().sync();

    for (let i = 1; i <= 3; i += 1) {
      clock = new Date(Date.parse("2026-08-14T10:00:00Z") + i * 60_000);
      await runner().tick();
      // Let the run finish so the next tick is not blocked by it.
      await handle.db.update(runs).set({ status: "succeeded" });
    }

    expect(await listRuns()).toHaveLength(2);
    const row = await automation();
    expect(row?.status).toBe("completed");
    expect(row?.statusReason).toMatch(/2 runs/);
  });

  it("disables itself when its runs keep failing", async () => {
    await deploy(
      manifest({
        schedules: [schedule({ every: "1m", loop: { maxConsecutiveFailures: 2 } })],
      }),
    );
    await runner().sync();

    for (let i = 1; i <= 4; i += 1) {
      clock = new Date(Date.parse("2026-08-14T10:00:00Z") + i * 60_000);
      await runner().tick();
      await handle.db.update(runs).set({ status: "failed" });
    }

    const row = await automation();
    // Two failures in a row is the limit, so it must stop rather than fail
    // every minute forever.
    expect(row?.status).toBe("disabled");
    expect(row?.statusReason).toMatch(/failures in a row/);
    expect(await listRuns()).toHaveLength(2);
  });

  it("forgets failures after a success", async () => {
    await deploy(
      manifest({ schedules: [schedule({ every: "1m", loop: { maxConsecutiveFailures: 2 } })] }),
    );
    await runner().sync();

    clock = new Date("2026-08-14T10:01:00Z");
    await runner().tick();
    await handle.db.update(runs).set({ status: "failed" });

    clock = new Date("2026-08-14T10:02:00Z");
    await runner().tick();
    await handle.db.update(runs).set({ status: "succeeded" });

    clock = new Date("2026-08-14T10:03:00Z");
    await runner().tick();

    // A blip is not a broken automation.
    expect((await automation())?.status).toBe("active");
    expect(await listRuns()).toHaveLength(3);
  });
});

describe("budgets", () => {
  it("skips a firing over the daily budget without disabling the schedule", async () => {
    const base = manifest({ schedules: [schedule({ every: "1h" })] });
    await deploy({
      ...base,
      runtime: { ...base.runtime, limits: { ...base.runtime.limits, dailySpendUsd: 1 } },
    });
    await runner().sync();

    await handle.db.insert(runs).values({
      id: "run_spent",
      workspaceId,
      agentId,
      status: "succeeded",
      trigger: "manual",
      costUsd: "5.00",
    });

    clock = new Date("2026-08-14T11:00:00Z");
    expect(await runner().tick()).toBe(0);

    const row = await automation();
    // Tomorrow the allowance resets, so the automation stays alive — but the
    // user is told why nothing happened.
    expect(row?.status).toBe("active");
    expect(row?.statusReason).toMatch(/budget/);
  });
});

describe("event automations", () => {
  const eventTrigger = {
    name: "on-approval",
    event: "approval.requested" as const,
    enabled: true,
    loop: { maxConsecutiveFailures: 5 },
  };

  beforeEach(async () => {
    await deploy(manifest({ events: [eventTrigger] }));
    await runner().sync();
  });

  it("starts a run when a matching event arrives", async () => {
    clock = new Date("2026-08-14T10:01:00Z");
    await appendEvent(handle.db, "approval.requested", {
      workspaceId,
      agentId,
      data: { tool: "shell" },
    });

    expect(await runner().tick()).toBe(1);
    const [run] = await listRuns();
    expect(run?.trigger).toBe("event");
    expect((run?.input as { text: string } | undefined)?.text).toContain("approval.requested");
  });

  it("ignores events of other types", async () => {
    await appendEvent(handle.db, "run.failed", { workspaceId, agentId });
    expect(await runner().tick()).toBe(0);
  });

  it("delivers each event once", async () => {
    await appendEvent(handle.db, "approval.requested", { workspaceId, agentId });
    await runner().tick();
    await handle.db.update(runs).set({ status: "succeeded" });

    expect(await runner().tick()).toBe(0);
    expect(await listRuns()).toHaveLength(1);
  });

  it("does not trigger on events its own runs produced", async () => {
    // The cycle guard. Without it, an automation that reacts to run events
    // re-triggers itself forever.
    const [runId] = await handle.db
      .insert(runs)
      .values({ id: "run_auto", workspaceId, agentId, status: "running", trigger: "event" })
      .returning({ id: runs.id });
    await appendEvent(handle.db, "approval.requested", {
      workspaceId,
      agentId,
      runId: runId?.id,
    });

    expect(await runner().tick()).toBe(0);
  });

  it("still triggers on events from work a person started", async () => {
    const [runId] = await handle.db
      .insert(runs)
      .values({ id: "run_manual", workspaceId, agentId, status: "running", trigger: "manual" })
      .returning({ id: runs.id });
    await appendEvent(handle.db, "approval.requested", {
      workspaceId,
      agentId,
      runId: runId?.id,
    });

    expect(await runner().tick()).toBe(1);
  });
});
