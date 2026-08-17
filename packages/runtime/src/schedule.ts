import { BridgeError } from "@bridge/core";
import { type EventTrigger, parseDuration, type ScheduleTrigger } from "@bridge/spec";
import { CronExpressionParser } from "cron-parser";

/**
 * When does this fire next, and should it fire at all?
 *
 * Kept free of the database so the parts that are easy to get wrong —
 * timezones, daylight saving, a loop's ending — are testable by calling a
 * function with a date.
 */
export type AutomationKind = "cron" | "interval" | "event";

export function kindOf(trigger: ScheduleTrigger): "cron" | "interval" {
  return trigger.cron ? "cron" : "interval";
}

/**
 * The next firing at or after `from`.
 *
 * Cron is evaluated **in the schedule's own timezone**, which is the whole
 * reason the field exists: "weekdays at 9am" means 9am where the user lives,
 * and it has to keep meaning that when the clocks change. The stored value
 * is a UTC instant, so nothing downstream has to think about it again.
 */
export function nextFireTime(trigger: ScheduleTrigger, from: Date, defaultZone = "UTC"): Date {
  if (trigger.cron) {
    try {
      return CronExpressionParser.parse(trigger.cron, {
        currentDate: from,
        // The schedule's own zone wins; otherwise the workspace's, so "9am"
        // means 9am where the user is without every manifest saying so.
        tz: trigger.timezone ?? defaultZone,
      })
        .next()
        .toDate();
    } catch (err) {
      // A cron expression that does not parse is a manifest error, not a
      // runtime one — say which schedule, because a manifest may have many.
      throw new BridgeError(
        "validation_failed",
        `schedule "${trigger.name}" has an invalid cron expression or timezone: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const every = trigger.every ? parseDuration(trigger.every) : undefined;
  if (!every) {
    throw new BridgeError(
      "validation_failed",
      `schedule "${trigger.name}" needs a cron expression or an interval like "5m"`,
    );
  }
  return new Date(from.getTime() + every);
}

/**
 * A missed window is not a backlog.
 *
 * A laptop that was asleep for six hours must not wake up and fire six
 * hourly runs at once — that is a surprise bill and a thundering herd. So
 * catching up means "run once now, then resume the normal rhythm", which is
 * what a person means when they say a schedule was missed.
 */
export function catchUpFrom(trigger: ScheduleTrigger, now: Date, defaultZone = "UTC"): Date {
  return nextFireTime(trigger, now, defaultZone);
}

/** Is this a timezone this machine understands? */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export interface LoopState {
  runsCount: number;
  consecutiveFailures: number;
}

/**
 * Has this loop finished, and why?
 *
 * Returned as a sentence rather than a boolean because the reason is shown
 * to the user: "stopped after 10 runs" and "stopped after 5 failures in a
 * row" call for very different responses.
 */
export function loopEnded(
  trigger: ScheduleTrigger | EventTrigger,
  state: LoopState,
  now: Date,
): { status: "completed" | "disabled"; reason: string } | undefined {
  const { loop } = trigger;

  if (loop.maxRuns !== undefined && state.runsCount >= loop.maxRuns) {
    return {
      status: "completed",
      reason: `finished after ${loop.maxRuns} ${loop.maxRuns === 1 ? "run" : "runs"}`,
    };
  }
  if (loop.until && now.getTime() >= Date.parse(loop.until)) {
    return { status: "completed", reason: `reached its end time (${loop.until})` };
  }
  if (state.consecutiveFailures >= loop.maxConsecutiveFailures) {
    return {
      status: "disabled",
      reason: `stopped after ${state.consecutiveFailures} failures in a row`,
    };
  }
  return undefined;
}

/** A human sentence for when this runs, for lists and confirmations. */
export function describeSchedule(trigger: ScheduleTrigger, defaultZone = "UTC"): string {
  if (trigger.every) return `every ${trigger.every}`;
  return `${trigger.cron} (${trigger.timezone ?? defaultZone})`;
}
