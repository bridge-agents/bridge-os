/**
 * Short durations, for schedules people write by hand.
 *
 * "Every five minutes" is the most common automation anyone wants and the
 * one cron expresses worst — a five-field expression with a step is
 * something you look up. So an interval schedule takes `every: "5m"`, and
 * cron stays for the calendar cases it is actually good at ("weekdays at
 * 9am").
 *
 * Deliberately small: no weeks, months or years, because past a day the
 * question becomes "which day" and that is cron's job.
 */
const PATTERN = /^(\d+)(s|m|h|d)$/;

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Milliseconds, or undefined if this is not a duration. */
export function parseDuration(value: string): number | undefined {
  const match = PATTERN.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = UNITS[match[2] as string];
  if (!unit || amount <= 0) return undefined;
  return amount * unit;
}

export function isDuration(value: string): boolean {
  return parseDuration(value) !== undefined;
}

/** "90m" → "1h 30m", for telling someone when something next runs. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return "0s";
  const parts: string[] = [];
  let left = Math.floor(ms / 1000);
  for (const [unit, seconds] of [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(left / seconds);
    if (amount > 0) parts.push(`${amount}${unit}`);
    left -= amount * seconds;
  }
  // Two units is enough to be useful without being fussy: "1h 30m", not
  // "1h 30m 12s".
  return parts.slice(0, 2).join(" ");
}
