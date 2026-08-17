import {
  bigint,
  bigserial,
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
  description: text("description"),
  /**
   * IANA zone for anything that means a time of day — schedules, mostly.
   * Null means UTC. A schedule may still name its own zone; this is what
   * "9am" means when nobody said where.
   */
  timezone: text("timezone"),
  /**
   * What a run uses when nothing else says.
   *
   * The web composer always sends an explicit model, so chat worked while
   * automations, the CLI and channels fell back to whatever the agent's
   * manifest happened to name — often a local endpoint that is not running.
   * This is the one place to set the answer for all of them.
   */
  defaultModel: jsonb("default_model").$type<{ provider: string; model: string } | null>(),
  defaultReasoning: text("default_reasoning"),
  /**
   * Folders on this machine that agents may work in, on top of whatever an
   * agent's own manifest allows. Machine paths do not belong in a portable
   * manifest, so the workspace is where "my Downloads folder" lives.
   */
  allowedPaths: jsonb("allowed_paths").$type<string[]>().notNull().default([]),
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

/** Long-lived programmatic credentials; raw values are shown once and never stored. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

/** One-time PKCE state for an OpenID Connect sign-in redirect. */
export const oidcStates = pgTable("oidc_states", {
  stateHash: text("state_hash").primaryKey(),
  encryptedPayload: text("encrypted_payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    createdAt,
  },
  (t) => [unique().on(t.provider, t.subject), index("auth_identities_user_idx").on(t.userId)],
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

/** Email-bound, expiring invitations; only a hash of the acceptance token is stored. */
export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("workspace_invitations_workspace_idx").on(t.workspaceId, t.createdAt),
    index("workspace_invitations_email_idx").on(t.email),
  ],
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
    /** User-curated threads stay above recency-sorted conversation history. */
    pinned: boolean("pinned").notNull().default(false),
    /**
     * Last time anything was said here, in either direction.
     *
     * Ordering by creation buried a thread the moment a newer one existed,
     * however active it still was — the terminal and the sidebar both want
     * "what I was last talking about", which is this.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/** Durable agent memory, separate from a single conversation transcript. */
/**
 * What an agent has come to know, as a graph.
 *
 * `memory_entries` stays the raw journal — every turn, appended cheaply. This
 * is the considered version: facts consolidated out of that journal in the
 * background, deduplicated against what is already known, and linked to each
 * other. One row is one thing worth remembering, not one thing that was said.
 */
export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Short name — what the node is called in the graph. */
    title: text("title").notNull(),
    /** person | project | preference | fact | event */
    kind: text("kind").notNull().default("fact"),
    body: text("body").notNull(),
    /**
     * How sure we are, 0–1. Consolidation raises it when something is seen
     * again and lowers it when it is contradicted, so a passing remark and a
     * standing instruction are not weighted the same.
     */
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull().default("0.5"),
    /** How many times this has been reinforced by later conversation. */
    mentions: integer("mentions").notNull().default(1),
    /** The run that last touched it, for tracing a fact back to its source. */
    sourceRunId: text("source_run_id"),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("knowledge_nodes_agent_idx").on(t.workspaceId, t.agentId, t.updatedAt),
    unique("knowledge_nodes_title_unique").on(t.agentId, t.title),
  ],
);

/** A link between two things known. Undirected in the view, stored one way. */
export const knowledgeEdges = pgTable(
  "knowledge_edges",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fromId: text("from_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => knowledgeNodes.id, { onDelete: "cascade" }),
    /** How they relate, in a few words: "works on", "prefers", "lives in". */
    relation: text("relation").notNull().default("related to"),
    createdAt,
  },
  (t) => [
    index("knowledge_edges_from_idx").on(t.fromId),
    index("knowledge_edges_to_idx").on(t.toId),
    unique("knowledge_edges_unique").on(t.fromId, t.toId),
  ],
);

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    kind: text("kind").notNull().default("long-term"), // long-term | knowledge
    content: text("content").notNull(),
    /**
     * Null until consolidation has read this turn into the knowledge graph.
     * Consolidating on a schedule rather than per message is the difference
     * between a memory and a transcript.
     */
    consolidatedAt: timestamp("consolidated_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [
    index("memory_entries_workspace_agent_idx").on(t.workspaceId, t.agentId, t.createdAt),
    index("memory_entries_run_idx").on(t.runId),
  ],
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

/**
 * Files uploaded with a chat turn. Bytes live on the configured data volume;
 * this table keeps tenancy, ownership, and durable conversation references.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storagePath: text("storage_path").notNull(),
    createdAt,
  },
  (t) => [
    index("attachments_workspace_idx").on(t.workspaceId),
    index("attachments_conversation_idx").on(t.conversationId, t.createdAt),
    index("attachments_run_idx").on(t.runId),
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

/** Short-lived durable stream deltas shared by API and worker processes. */
export const runStreamEvents = pgTable(
  "run_stream_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt,
  },
  (t) => [index("run_stream_events_run_seq_idx").on(t.runId, t.seq)],
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
    /** Pending approvals expire into a denial so unattended runs do not wait forever. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
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
    /** api-key | endpoint | oauth-cli. OAuth CLI credentials remain in the vendor keychain. */
    authType: text("auth_type").notNull().default("api-key"),
    secretId: text("secret_id").references(() => secrets.id, { onDelete: "set null" }),
    /** For OpenAI-compatible and local endpoints (Ollama, LM Studio, proxies). */
    baseUrl: text("base_url"),
    createdAt,
  },
  (t) => [unique().on(t.workspaceId, t.provider)],
);

/** Workspace web-search backend used by the native web-search tool. */
export const searchConfigs = pgTable("search_configs", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  endpoint: text("endpoint").notNull(),
  secretId: text("secret_id").references(() => secrets.id, { onDelete: "set null" }),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceDashboards = pgTable("workspace_dashboards", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  document: jsonb("document").notNull(),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit/event log; see @bridge/spec events for the type catalog. */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    /**
     * Total order over the log. Automations read the log with a cursor, and
     * a timestamp cannot be a cursor: two events in the same millisecond are
     * indistinguishable, so one gets delivered twice or not at all. A
     * sequence has no ties.
     */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id"),
    runId: text("run_id"),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt,
  },
  (t) => [
    index("events_workspace_created_idx").on(t.workspaceId, t.createdAt),
    index("events_workspace_seq_idx").on(t.workspaceId, t.seq),
  ],
);

/**
 * A live automation: one trigger from an agent's manifest, given a position
 * in time and a memory of what it has already done.
 *
 * Manifests are portable documents (ADR-0008) and cannot hold "when did this
 * last fire" — that is state, and it belongs to this install. So a deployed
 * agent's triggers are projected into rows here, and the manifest stays the
 * declaration while the row does the work.
 *
 * Schedules and event subscriptions share one table because they need the
 * same things: pausing, loop bounds, failure counting, and a record of the
 * last run. One table means one set of guards rather than two that drift.
 */
export const automations = pgTable(
  "automations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Trigger name from the manifest — stable across redeploys. */
    name: text("name").notNull(),
    /** cron | interval | event */
    kind: text("kind").notNull(),
    /** The trigger as written in the manifest, so the runner needs nothing else. */
    spec: jsonb("spec").notNull(),
    /** active | paused | completed | disabled */
    status: text("status").notNull().default("active"),
    /**
     * When this fires next. Null for event automations, which wait on the
     * log rather than the clock. The claim is a compare-and-swap on this
     * column, which is what stops two runners firing the same tick.
     */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    /**
     * How far an event automation has read the event log. Advancing this and
     * creating the run in one transaction is what makes delivery
     * exactly-once rather than at-least-once.
     */
    cursorSeq: bigint("cursor_seq", { mode: "number" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    runsCount: integer("runs_count").notNull().default(0),
    /** Reset by a success; a run of these is what disables an automation. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Why Bridge stopped it, in words a person can act on. */
    statusReason: text("status_reason"),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.agentId, t.name),
    index("automations_due_idx").on(t.status, t.nextRunAt),
    index("automations_workspace_idx").on(t.workspaceId),
  ],
);
