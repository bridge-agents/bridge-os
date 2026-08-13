import {
  bigint,
  boolean,
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

/** A thread of messages with an agent. Runs attach to one. */
export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title"),
    /**
     * Stable key for a thread that lives outside Bridge, e.g.
     * "telegram:12345". How a channel finds the same conversation again after
     * a restart instead of starting the agent over on every message.
     */
    externalId: text("external_id"),
    createdAt,
  },
  (t) => [
    index("conversations_workspace_agent_idx").on(t.workspaceId, t.agentId),
    unique().on(t.agentId, t.externalId),
  ],
);

/** Conversation history — the durable record the runtime replays into a model. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    role: text("role").notNull(), // system | user | assistant | tool
    content: text("content").notNull().default(""),
    /** Which agent in the manifest produced this, for multi-agent transcripts. */
    agentName: text("agent_name"),
    toolCalls: jsonb("tool_calls"),
    toolCallId: text("tool_call_id"),
    createdAt,
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
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
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    // queued | running | waiting_approval | succeeded | failed | cancelled
    status: text("status").notNull().default("queued"),
    trigger: text("trigger").notNull().default("manual"), // manual | schedule | event | channel
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    /** Set by the API; the worker checks it at every step boundary. */
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    attempt: integer("attempt").notNull().default(0),
    /**
     * Serialized agent-loop stack, written when a run pauses for approval so
     * it can be resumed exactly where it stopped rather than replayed.
     */
    checkpoint: jsonb("checkpoint"),
    /**
     * Refreshed while a worker holds the run. A stale heartbeat is how a
     * crashed worker's run gets reclaimed instead of hanging forever.
     */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_workspace_agent_idx").on(t.workspaceId, t.agentId),
    index("runs_status_idx").on(t.status),
  ],
);

/** Ordered trace of everything a run did — the observability spine. */
export const runSteps = pgTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    // model_call | tool_call | delegation | error
    type: text("type").notNull(),
    agentName: text("agent_name"),
    data: jsonb("data").notNull().default({}),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    createdAt,
  },
  (t) => [unique().on(t.runId, t.seq)],
);

/**
 * A tool call a human has to decide on. Created when the permission policy
 * says `ask`; the run parks in `waiting_approval` until it is resolved.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** Which agent in the manifest asked, for multi-agent runs. */
    agentName: text("agent_name"),
    toolName: text("tool_name").notNull(),
    action: text("action").notNull(),
    input: jsonb("input").notNull().default({}),
    status: text("status").notNull().default("pending"), // pending | approved | denied
    /** Shown to the model when denied, so it can adapt rather than just fail. */
    reason: text("reason"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
    index("approvals_run_idx").on(t.runId),
  ],
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
