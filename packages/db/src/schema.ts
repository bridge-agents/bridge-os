import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Phase 1 baseline schema. Every domain table is workspace-scoped:
 * multi-tenant isolation is a query invariant from day one. Manifests are
 * jsonb (the Manifest is the source of truth — rows are parsed through
 * @bridge/spec on read); relational columns index what queries need.
 */

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt,
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt,
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    specVersion: integer("spec_version").notNull(),
    manifest: jsonb("manifest").notNull(),
    status: text("status").notNull().default("draft"), // draft | deployed | stopped | archived
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.workspaceId, t.slug), index("agents_workspace_idx").on(t.workspaceId)],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // queued | running | waiting_approval | succeeded | failed | cancelled
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull().default("manual"), // manual | schedule | event | channel
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_workspace_agent_idx").on(t.workspaceId, t.agentId)],
);

/** Append-only audit/event log; see @bridge/spec events for the type catalog. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    runId: text("run_id"),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt,
  },
  (t) => [index("events_workspace_created_idx").on(t.workspaceId, t.createdAt)],
);
