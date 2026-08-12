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
  /** scrypt hash; null for accounts authenticated by a Cloud identity provider. */
  passwordHash: text("password_hash"),
  createdAt,
});

/** Only the hash of a session token is stored, so a database leak yields no usable sessions. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

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

/**
 * Encrypted credentials. `ciphertext` is AES-256-GCM (see @bridge/core
 * crypto); plaintext never touches this table, the API, or the logs. On
 * desktop the same rows may instead hold a keychain reference (ADR-0011).
 */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    /** Recognisable fragment for the UI, e.g. "sk-…f4a2". Never enough to use. */
    hint: text("hint"),
    createdAt,
  },
  (t) => [unique().on(t.workspaceId, t.name)],
);

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Adapter id referenced by Manifest ModelRefs, e.g. "anthropic". */
    provider: text("provider").notNull(),
    secretId: text("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    /** For OpenAI-compatible and local endpoints (Ollama, LM Studio, proxies). */
    baseUrl: text("base_url"),
    createdAt,
  },
  (t) => [unique().on(t.workspaceId, t.provider)],
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
