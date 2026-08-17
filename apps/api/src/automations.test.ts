import { agents, automations } from "@bridge/db";
import { AutomationRunner } from "@bridge/runtime";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

/**
 * The automation API.
 *
 * Rows here are projected from manifests, so an edit or delete has to reach
 * the manifest — a row changed on its own would be silently reverted by the
 * next reconcile. That, control (pause, resume, run now), and never showing
 * one tenant another's schedules are what these cover.
 */
let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let path: string;
let agentId: string;

const manifest = (triggers: unknown) => ({
  specVersion: 1,
  meta: { name: "Watcher", slug: "watcher" },
  models: { default: { provider: "openai-compatible", model: "local" } },
  agents: [{ name: "main", instructions: "Watch." }],
  entryAgent: "main",
  triggers,
});

/** Project the manifest's triggers, exactly as the running runtime does. */
const sync = () =>
  new AutomationRunner({ db: ctx.handle.db, logger: pino({ level: "silent" }) }).sync();

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  path = `/v1/workspaces/${user.workspaceId}/automations`;

  const created = await (
    await api(`/v1/workspaces/${user.workspaceId}/agents`, {
      method: "POST",
      body: JSON.stringify({
        manifest: manifest({
          schedules: [
            { name: "nightly", cron: "0 3 * * *", timezone: "UTC", input: "Tidy up" },
            { name: "poll", every: "15m", loop: { maxRuns: 4 } },
          ],
          events: [{ name: "on-failure", event: "run.failed" }],
        }),
      }),
    })
  ).json();
  agentId = (created as { agent: { id: string } }).agent.id;

  // Only deployed agents have live automations.
  await ctx.handle.db.update(agents).set({ status: "deployed" }).where(eq(agents.id, agentId));
  await sync();
});

afterEach(async () => {
  await ctx.close();
});

const list = async () => {
  const body = (await (await api(path)).json()) as {
    automations: {
      id: string;
      name: string;
      title: string;
      kind: string;
      schedule: string;
      status: string;
      statusReason: string | null;
      nextRunAt: string | null;
      runsCount: number;
    }[];
  };
  return body.automations;
};

const find = async (name: string) => {
  const found = (await list()).find((row) => row.name === name);
  if (!found) throw new Error(`no automation named ${name}`);
  return found;
};

describe("listing automations", () => {
  it("shows every trigger a deployed agent declares", async () => {
    const names = (await list()).map((row) => row.name).sort();
    expect(names).toEqual(["nightly", "on-failure", "poll"]);
  });

  it("describes the schedule in words, so no client parses cron", async () => {
    expect((await find("nightly")).schedule).toBe("0 3 * * * (UTC)");
    expect((await find("poll")).schedule).toBe("every 15m");
    expect((await find("on-failure")).schedule).toBe("on run.failed");
  });

  it("says when each one next runs", async () => {
    const nightly = await find("nightly");
    expect(nightly.nextRunAt).toBeTruthy();
    expect(new Date(nightly.nextRunAt as string).getUTCHours()).toBe(3);

    // An event automation waits on the log, not the clock.
    expect((await find("on-failure")).nextRunAt).toBeNull();
  });

  it("can be narrowed to one agent", async () => {
    const res = await api(`${path}?agent=${agentId}`);
    expect(((await res.json()) as { automations: unknown[] }).automations).toHaveLength(3);

    const other = await api(`${path}?agent=agt_nonexistent`);
    expect(((await other.json()) as { automations: unknown[] }).automations).toHaveLength(0);
  });
});

describe("pausing and resuming", () => {
  it("pauses an automation and clears its next run", async () => {
    const poll = await find("poll");
    const res = await api(`${path}/${poll.id}/pause`, { method: "POST" });
    expect(res.status).toBe(200);

    const after = await find("poll");
    expect(after.status).toBe("paused");
    expect(after.statusReason).toMatch(/paused by you/);
  });

  it("resumes from now rather than firing for every slot it missed", async () => {
    const poll = await find("poll");
    await api(`${path}/${poll.id}/pause`, { method: "POST" });
    await api(`${path}/${poll.id}/resume`, { method: "POST" });

    const after = await find("poll");
    expect(after.status).toBe("active");
    expect(after.statusReason).toBeNull();
    // 15 minutes from now, give or take the time this test took.
    const wait = Date.parse(after.nextRunAt as string) - Date.now();
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
  });

  it("keeps the count when resuming a loop that was only paused", async () => {
    const poll = await find("poll");
    await ctx.handle.db
      .update(automations)
      .set({ runsCount: 2 })
      .where(eq(automations.id, poll.id));

    await api(`${path}/${poll.id}/pause`, { method: "POST" });
    await api(`${path}/${poll.id}/resume`, { method: "POST" });

    // Stopping a 3-of-4 loop and restarting it should give the fourth run,
    // not four more.
    expect((await find("poll")).runsCount).toBe(2);
  });

  it("starts the count over when resuming a loop that finished", async () => {
    const poll = await find("poll");
    await ctx.handle.db
      .update(automations)
      .set({ status: "completed", runsCount: 4, statusReason: "finished after 4 runs" })
      .where(eq(automations.id, poll.id));

    await api(`${path}/${poll.id}/resume`, { method: "POST" });

    // Otherwise resume is a dead end: it would re-complete on the next tick.
    const after = await find("poll");
    expect(after.status).toBe("active");
    expect(after.runsCount).toBe(0);
  });

  it("clears a failure count so a fixed automation can run again", async () => {
    const poll = await find("poll");
    await ctx.handle.db
      .update(automations)
      .set({ status: "disabled", consecutiveFailures: 5, statusReason: "stopped after 5 failures" })
      .where(eq(automations.id, poll.id));

    await api(`${path}/${poll.id}/resume`, { method: "POST" });

    const [row] = await ctx.handle.db.select().from(automations).where(eq(automations.id, poll.id));
    expect(row?.status).toBe("active");
    expect(row?.consecutiveFailures).toBe(0);
  });
});

describe("running one now", () => {
  it("starts a run without moving the schedule", async () => {
    const nightly = await find("nightly");
    const before = nightly.nextRunAt;

    const res = await api(`${path}/${nightly.id}/run`, { method: "POST" });
    expect(res.status).toBe(201);
    expect((await res.json()) as { run: { id: string } }).toMatchObject({
      run: { id: expect.stringMatching(/^run_/) },
    });

    // Testing an automation must not change when it fires on its own.
    expect((await find("nightly")).nextRunAt).toBe(before);
  });

  it("refuses when the agent is not deployed", async () => {
    await ctx.handle.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agentId));
    const nightly = await find("nightly");

    const res = await api(`${path}/${nightly.id}/run`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("editing", () => {
  const manifestOf = async () => {
    const [row] = await ctx.handle.db
      .select({ manifest: agents.manifest })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.manifest as {
      triggers: { schedules: Record<string, unknown>[]; events: Record<string, unknown>[] };
    };
  };

  it("writes the change into the agent's manifest, not just the row", async () => {
    // The row alone would be overwritten the next time the runner syncs.
    const poll = await find("poll");
    const res = await api(`${path}/${poll.id}`, {
      method: "PATCH",
      body: JSON.stringify({ every: "45m", input: "Look for anything new" }),
    });
    expect(res.status).toBe(200);

    const trigger = (await manifestOf()).triggers.schedules.find((t) => t.name === "poll");
    expect(trigger?.every).toBe("45m");
    expect(trigger?.input).toBe("Look for anything new");
  });

  it("changes the display title without replacing the stable automation", async () => {
    const nightly = await find("nightly");
    const res = await api(`${path}/${nightly.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Morning operations report" }),
    });
    expect(res.status).toBe(200);

    const trigger = (await manifestOf()).triggers.schedules.find(
      (candidate) => candidate.name === "nightly",
    );
    expect(trigger?.title).toBe("Morning operations report");
    const updated = await find("nightly");
    expect(updated.id).toBe(nightly.id);
    expect(updated.title).toBe("Morning operations report");
  });

  it("re-projects immediately, so the next run time is right away", async () => {
    const poll = await find("poll");
    await api(`${path}/${poll.id}`, { method: "PATCH", body: JSON.stringify({ every: "45m" }) });

    const after = await find("poll");
    expect(after.schedule).toBe("every 45m");
    const wait = Date.parse(after.nextRunAt as string) - Date.now();
    expect(wait).toBeGreaterThan(44 * 60_000);
  });

  it("clears the other kind of schedule rather than keeping both", async () => {
    // cron and every are mutually exclusive; leaving both would produce a
    // manifest the schema rejects.
    const nightly = await find("nightly");
    await api(`${path}/${nightly.id}`, { method: "PATCH", body: JSON.stringify({ every: "6h" }) });

    const trigger = (await manifestOf()).triggers.schedules.find((t) => t.name === "nightly");
    expect(trigger?.every).toBe("6h");
    expect(trigger?.cron).toBeUndefined();
    expect((await find("nightly")).kind).toBe("interval");
  });

  it("can switch an interval back to a time of day, in a named zone", async () => {
    const poll = await find("poll");
    await api(`${path}/${poll.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cron: "0 7 * * *", timezone: "Europe/London" }),
    });

    expect((await find("poll")).schedule).toBe("0 7 * * * (Europe/London)");
  });

  it("changes the loop's ending", async () => {
    const poll = await find("poll");
    await api(`${path}/${poll.id}`, {
      method: "PATCH",
      body: JSON.stringify({ loop: { maxRuns: 9 } }),
    });

    const trigger = (await manifestOf()).triggers.schedules.find((t) => t.name === "poll");
    expect((trigger?.loop as { maxRuns: number } | undefined)?.maxRuns).toBe(9);
  });

  it("removes an ending when it is cleared", async () => {
    const poll = await find("poll");
    await api(`${path}/${poll.id}`, {
      method: "PATCH",
      body: JSON.stringify({ loop: { maxRuns: null } }),
    });

    const trigger = (await manifestOf()).triggers.schedules.find((t) => t.name === "poll");
    expect((trigger?.loop as { maxRuns?: number } | undefined)?.maxRuns).toBeUndefined();
  });

  it("refuses an edit that would make the manifest invalid", async () => {
    const poll = await find("poll");
    const res = await api(`${path}/${poll.id}`, {
      method: "PATCH",
      body: JSON.stringify({ every: "whenever" }),
    });

    // Rejected before anything is written, so the agent is left as it was.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const trigger = (await manifestOf()).triggers.schedules.find((t) => t.name === "poll");
    expect(trigger?.every).toBe("15m");
  });

  it("refuses a timezone this machine does not know", async () => {
    const nightly = await find("nightly");
    const res = await api(`${path}/${nightly.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cron: "0 9 * * *", timezone: "Mars/Olympus" }),
    });
    // 422: it failed the request schema, which is where an unknown zone is
    // caught — before anything reaches the manifest.
    expect(res.status).toBe(422);
  });
});

describe("deleting", () => {
  it("removes the trigger from the manifest and the row with it", async () => {
    const poll = await find("poll");
    const res = await api(`${path}/${poll.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const [row] = await ctx.handle.db
      .select({ manifest: agents.manifest })
      .from(agents)
      .where(eq(agents.id, agentId));
    const triggers = (row?.manifest as { triggers: { schedules: { name: string }[] } } | undefined)
      ?.triggers;
    if (!triggers) throw new Error("manifest missing");
    expect(triggers.schedules.map((t) => t.name)).toEqual(["nightly"]);

    // And it does not come back on the next reconcile, which is the whole
    // reason delete has to reach the manifest.
    await sync();
    expect((await list()).map((a) => a.name).sort()).toEqual(["nightly", "on-failure"]);
  });

  it("deletes an event trigger too", async () => {
    const onFailure = await find("on-failure");
    expect((await api(`${path}/${onFailure.id}`, { method: "DELETE" })).status).toBe(204);

    await sync();
    expect((await list()).map((a) => a.name).sort()).toEqual(["nightly", "poll"]);
  });
});

describe("workspace boundaries", () => {
  it("hides another tenant's automations", async () => {
    const stranger = await signUp(ctx.app, "stranger@example.com");
    const theirs = as(ctx.app, stranger);

    const res = await theirs(`/v1/workspaces/${stranger.workspaceId}/automations`);
    expect(((await res.json()) as { automations: unknown[] }).automations).toHaveLength(0);
  });

  it("refuses to delete an automation in another workspace", async () => {
    const stranger = await signUp(ctx.app, "stranger@example.com");
    const theirs = as(ctx.app, stranger);
    const poll = await find("poll");

    const res = await theirs(`/v1/workspaces/${stranger.workspaceId}/automations/${poll.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    expect(await find("poll")).toBeTruthy();
  });

  it("refuses to control an automation in another workspace", async () => {
    const stranger = await signUp(ctx.app, "stranger@example.com");
    const theirs = as(ctx.app, stranger);
    const poll = await find("poll");

    // not_found, never forbidden — confirming it exists would leak that the
    // other tenant has it.
    const res = await theirs(
      `/v1/workspaces/${stranger.workspaceId}/automations/${poll.id}/pause`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect((await find("poll")).status).toBe("active");
  });
});
