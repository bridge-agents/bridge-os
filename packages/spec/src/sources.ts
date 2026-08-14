/**
 * The data a dashboard widget is allowed to bind to.
 *
 * A closed catalogue, deliberately. Widget `source` is a string in the
 * schema, and if the renderer resolved arbitrary strings then a dashboard —
 * which the AI writes and a user can import — would decide what data to
 * read. Naming every source here makes the set auditable, gives the AI a
 * vocabulary it cannot exceed, and means an unknown source renders as
 * "unavailable" rather than an error or, worse, someone else's data.
 *
 * Every source is workspace-scoped when it is resolved (ADR-0005).
 */

/**
 * Three shapes, so the renderer switches on `kind` and never on the source
 * name. Adding a source is data; adding a *shape* would be a renderer change.
 */
export type SourceKind = "metric" | "series" | "rows";

export interface SourceDefinition {
  name: string;
  kind: SourceKind;
  /** Shown to the AI so it picks sources by meaning, not by guessing names. */
  description: string;
  /** Unit hint for metrics, e.g. "usd" or "tokens". */
  unit?: string;
}

export const DATA_SOURCES: SourceDefinition[] = [
  // Metrics — a single number.
  { name: "runs.total", kind: "metric", description: "Total runs ever started" },
  { name: "runs.active", kind: "metric", description: "Runs queued or running right now" },
  {
    name: "runs.cost.total",
    kind: "metric",
    unit: "usd",
    description: "Total spend across all runs",
  },
  {
    name: "runs.tokens.total",
    kind: "metric",
    unit: "tokens",
    description: "Total tokens used across all runs",
  },
  {
    name: "approvals.pending.count",
    kind: "metric",
    description: "Approvals waiting on a human",
  },
  { name: "agents.deployed.count", kind: "metric", description: "Agents currently deployed" },

  // Series — a value per day, for charts.
  { name: "runs.count.daily", kind: "series", description: "Runs per day over the last 14 days" },
  {
    name: "runs.cost.daily",
    kind: "series",
    unit: "usd",
    description: "Spend per day over the last 14 days",
  },
  {
    name: "runs.tokens.daily",
    kind: "series",
    unit: "tokens",
    description: "Tokens per day over the last 14 days",
  },

  // Rows — tabular, for tables and lists.
  { name: "runs.recent", kind: "rows", description: "The most recent runs with status and cost" },
  { name: "runs.failed.recent", kind: "rows", description: "Recent runs that failed" },
  { name: "agents.all", kind: "rows", description: "Every agent with its status" },
  { name: "events.recent", kind: "rows", description: "Recent workspace activity" },
  { name: "logs.recent", kind: "rows", description: "Recent run steps — the execution trace" },
];

const BY_NAME = new Map(DATA_SOURCES.map((source) => [source.name, source]));

export function getDataSource(name: string): SourceDefinition | undefined {
  return BY_NAME.get(name);
}

export function isDataSource(name: string): boolean {
  return BY_NAME.has(name);
}

/** The catalogue as prompt text, so the AI cannot invent a source name. */
export function describeDataSources(): string {
  return DATA_SOURCES.map(
    (source) => `- ${source.name} (${source.kind}) — ${source.description}`,
  ).join("\n");
}

/** What a resolved source looks like on the wire. */
export type SourceData =
  | { kind: "metric"; value: number; unit?: string }
  | { kind: "series"; points: { label: string; value: number }[]; unit?: string }
  | { kind: "rows"; columns: string[]; rows: (string | number | null)[][] }
  /** A source the catalogue knows of but this deployment cannot answer yet. */
  | { kind: "unavailable"; reason: string };
