import { describe, expect, it } from "vitest";
import {
  calendarScheduleCron,
  describeSchedule,
  parseCalendarSchedule,
  parseInterval,
  scheduleInterval,
} from "./automationSchedule.js";

describe("automation schedule controls", () => {
  it("round-trips a weekday time without exposing cron to the user", () => {
    const schedule = parseCalendarSchedule("30 8 * * 1-5");
    expect(schedule).toEqual({ time: "08:30", days: [1, 2, 3, 4, 5], supported: true });
    expect(calendarScheduleCron(schedule.time, schedule.days)).toBe("30 8 * * 1,2,3,4,5");
  });

  it("supports every day and Sunday aliases", () => {
    expect(parseCalendarSchedule("0 9 * * *").days).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(parseCalendarSchedule("0 9 * * 7").days).toEqual([0]);
  });

  it("converts interval controls to the manifest duration format", () => {
    expect(parseInterval("6h")).toEqual({ amount: "6", unit: "h" });
    expect(scheduleInterval("3", "d")).toBe("3d");
  });
});

describe("describeSchedule", () => {
  it.each([
    ["0 7 * * 1-5", undefined, "Every weekday at 07:00"],
    ["30 18 * * *", undefined, "Every day at 18:30"],
    ["0 10 * * 0,6", undefined, "Every weekend day at 10:00"],
    ["0 9 * * 1", undefined, "Mon at 09:00"],
    ["15 6 * * 2,4", undefined, "Tue, Thu at 06:15"],
    [undefined, "5m", "Every 5 minutes"],
    [undefined, "1d", "Every day"],
    [undefined, undefined, "No schedule"],
  ])("%s / %s → %s", (cron, every, expected) => {
    expect(describeSchedule(cron, every)).toBe(expected);
  });

  /**
   * Anything these controls cannot express must show its cron rather than a
   * confident wrong description — "first of the month" read as "every day"
   * would be a lie about what runs unattended.
   */
  it("falls back to the expression it cannot describe", () => {
    expect(describeSchedule("0 10 1 * *")).toBe("0 10 1 * *");
  });
});
