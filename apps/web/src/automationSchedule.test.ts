import { describe, expect, it } from "vitest";
import {
  calendarScheduleCron,
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
