export const SCHEDULE_DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;

export type IntervalUnit = "s" | "m" | "h" | "d";

export interface CalendarSchedule {
  time: string;
  days: number[];
  supported: boolean;
}

const ALL_DAYS = SCHEDULE_DAYS.map((day) => day.value);

function expandDays(value: string): number[] | undefined {
  if (value === "*") return ALL_DAYS;
  const days = new Set<number>();
  for (const part of value.split(",")) {
    const range = /^(\d)-([0-7])$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) return undefined;
      for (let day = start; day <= end; day += 1) days.add(day === 7 ? 0 : day);
      continue;
    }
    if (!/^[0-7]$/.test(part)) return undefined;
    const day = Number(part);
    days.add(day === 7 ? 0 : day);
  }
  return SCHEDULE_DAYS.map((day) => day.value).filter((day) => days.has(day));
}

export function parseCalendarSchedule(cron: string | undefined): CalendarSchedule {
  const [minute, hour, dayOfMonth, month, weekdays, ...extra] = (cron ?? "").trim().split(/\s+/);
  const days = weekdays ? expandDays(weekdays) : undefined;
  const supported =
    extra.length === 0 &&
    /^\d{1,2}$/.test(minute ?? "") &&
    /^\d{1,2}$/.test(hour ?? "") &&
    Number(minute) <= 59 &&
    Number(hour) <= 23 &&
    dayOfMonth === "*" &&
    month === "*" &&
    Boolean(days?.length);

  return supported
    ? {
        time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        days: days as number[],
        supported: true,
      }
    : { time: "09:00", days: [1, 2, 3, 4, 5], supported: false };
}

export function calendarScheduleCron(time: string, days: number[]): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || days.length === 0) throw new Error("Choose a time and at least one day.");
  const selected = SCHEDULE_DAYS.map((day) => day.value).filter((day) => days.includes(day));
  const weekday = selected.length === SCHEDULE_DAYS.length ? "*" : selected.join(",");
  return `${Number(match[2])} ${Number(match[1])} * * ${weekday}`;
}

export function parseInterval(value: string | undefined): {
  amount: string;
  unit: IntervalUnit;
} {
  const match = /^(\d+)([smhd])$/.exec(value ?? "");
  return match
    ? { amount: match[1] as string, unit: match[2] as IntervalUnit }
    : { amount: "15", unit: "m" };
}

export function scheduleInterval(amount: string, unit: IntervalUnit): string {
  const parsed = Number(amount);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Choose a positive interval.");
  return `${parsed}${unit}`;
}
