import { ScheduleTriggerSchema } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { describeSchedule, kindOf, loopEnded, nextFireTime } from "./schedule.js";

/**
 * Scheduling arithmetic, without a database.
 *
 * Timezones and loop endings are the parts that are quietly wrong for weeks
 * — a schedule that fires an hour late after the clocks change, or a loop
 * that never stops — so they are tested by calling a function with a date
 * rather than by watching a system.
 */
const schedule = (fields: Record<string, unknown>) =>
  ScheduleTriggerSchema.parse({ name: "nightly", ...fields });

describe("next fire time", () => {
  it("follows a cron expression", () => {
    const next = nextFireTime(schedule({ cron: "0 9 * * *" }), new Date("2026-03-10T07:30:00Z"));
    expect(next.toISOString()).toBe("2026-03-10T09:00:00.000Z");
  });

  it("reads cron in the schedule's own timezone, not the server's", () => {
    // 9am in New York is 13:00 UTC in summer. A server in UTC must not fire
    // this at 9am UTC — the whole point of the field is that "9am" means 9am
    // where the person is.
    const next = nextFireTime(
      schedule({ cron: "0 9 * * *", timezone: "America/New_York" }),
      new Date("2026-07-01T00:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });

  it("keeps a wall-clock time across a daylight-saving change", () => {
    const trigger = schedule({ cron: "0 9 * * *", timezone: "America/New_York" });
    // Before the US spring-forward (EST, UTC-5) and after it (EDT, UTC-4).
    const winter = nextFireTime(trigger, new Date("2026-01-15T00:00:00Z"));
    const summer = nextFireTime(trigger, new Date("2026-07-15T00:00:00Z"));

    expect(winter.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(summer.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("handles weekday schedules", () => {
    // Saturday → the next firing is Monday, not tomorrow.
    const next = nextFireTime(
      schedule({ cron: "0 9 * * 1-5", timezone: "UTC" }),
      new Date("2026-08-15T12:00:00Z"),
    );
    expect(next.toISOString()).toBe("2026-08-17T09:00:00.000Z");
  });

  it("adds the interval for a loop", () => {
    const next = nextFireTime(schedule({ every: "5m" }), new Date("2026-08-14T10:00:00Z"));
    expect(next.toISOString()).toBe("2026-08-14T10:05:00.000Z");
  });

  it("names the schedule when its cron cannot be parsed", () => {
    // A manifest can hold many schedules; "invalid cron" alone is useless.
    expect(() => nextFireTime(schedule({ cron: "not a cron" }), new Date())).toThrow(/"nightly"/);
  });

  it("rejects an unknown timezone rather than silently using UTC", () => {
    expect(() =>
      nextFireTime(schedule({ cron: "0 9 * * *", timezone: "Mars/Olympus" }), new Date()),
    ).toThrow(/nightly/);
  });
});

describe("schedule shape", () => {
  it("requires exactly one of cron and every", () => {
    expect(ScheduleTriggerSchema.safeParse({ name: "a" }).success).toBe(false);
    expect(
      ScheduleTriggerSchema.safeParse({ name: "a", cron: "* * * * *", every: "5m" }).success,
    ).toBe(false);
  });

  it("rejects an interval that is not a duration", () => {
    const result = ScheduleTriggerSchema.safeParse({ name: "a", every: "soon" });
    expect(result.success).toBe(false);
  });

  it("knows which kind it is", () => {
    expect(kindOf(schedule({ cron: "* * * * *" }))).toBe("cron");
    expect(kindOf(schedule({ every: "1h" }))).toBe("interval");
  });

  it("describes itself for a list", () => {
    expect(describeSchedule(schedule({ every: "5m" }))).toBe("every 5m");
    expect(describeSchedule(schedule({ cron: "0 9 * * *", timezone: "UTC" }))).toBe(
      "0 9 * * * (UTC)",
    );
  });
});

describe("loop endings", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const state = (runsCount = 0, consecutiveFailures = 0) => ({ runsCount, consecutiveFailures });

  it("runs forever when nothing bounds it", () => {
    expect(loopEnded(schedule({ every: "5m" }), state(9999), now)).toBeUndefined();
  });

  it("completes after the requested number of runs", () => {
    const trigger = schedule({ every: "5m", loop: { maxRuns: 3 } });

    expect(loopEnded(trigger, state(2), now)).toBeUndefined();
    expect(loopEnded(trigger, state(3), now)).toMatchObject({ status: "completed" });
  });

  it("completes at its end time", () => {
    const trigger = schedule({ every: "5m", loop: { until: "2026-08-14T09:00:00Z" } });
    expect(loopEnded(trigger, state(1), now)).toMatchObject({ status: "completed" });
  });

  it("keeps running before its end time", () => {
    const trigger = schedule({ every: "5m", loop: { until: "2026-08-14T11:00:00Z" } });
    expect(loopEnded(trigger, state(1), now)).toBeUndefined();
  });

  it("disables itself after repeated failures, and says so", () => {
    const trigger = schedule({ every: "5m", loop: { maxConsecutiveFailures: 3 } });

    expect(loopEnded(trigger, state(10, 2), now)).toBeUndefined();
    const ended = loopEnded(trigger, state(10, 3), now);
    // "Disabled" rather than "completed": this one needs looking at, and the
    // reason is what the user reads.
    expect(ended).toMatchObject({ status: "disabled" });
    expect(ended?.reason).toMatch(/3 failures in a row/);
  });

  it("defaults to giving up after five failures rather than never", () => {
    const trigger = schedule({ every: "5m" });
    expect(loopEnded(trigger, state(10, 4), now)).toBeUndefined();
    expect(loopEnded(trigger, state(10, 5), now)).toMatchObject({ status: "disabled" });
  });
});
