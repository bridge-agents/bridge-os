/**
 * The only way this client talks to Bridge. Domain logic lives behind these
 * endpoints, never here — the CLI, desktop and mobile clients use the same
 * ones (ADR-0005).
 */
export interface ApiError {
  code: string;
  message: string;
  details?: { path: string; message: string }[];
}

export class BridgeApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
  }
}

/**
 * Exported because shared Bridge commands (`@bridge/commands`) need a way to
 * reach the API, and this is the only one the web client has (ADR-0005).
 */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    /**
     * A reply with no Bridge error in it did not come from Bridge — it came
     * from whatever is in front of it. Saying so beats repeating the status
     * line back at someone: "Internal Server Error" names no problem and
     * suggests no fix.
     */
    const error = (body as { error?: ApiError }).error;
    throw new BridgeApiError(
      res.status,
      error ?? {
        code: "internal",
        message: `The Bridge API answered ${res.status}. Check that it is running, and see its log for the reason.`,
      },
    );
  }
  return body as T;
}

const get = <T>(path: string) => request<T>(path);
const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface User {
  id: string;
  email: string;
  name: string | null;
}
export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  /** IANA zone; null means UTC. What "9am" means for schedules here. */
  timezone: string | null;
  /** What a run uses when nothing else says — chat, schedules, the CLI. */
  defaultModel: { provider: string; model: string } | null;
  defaultReasoning: string | null;
  /** Folders on this machine agents may work in. */
  allowedPaths: string[];
  role: string;
}
export interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  specVersion: number;
  updatedAt: string;
}
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  agents: number;
  tools: string[];
}
export interface ProviderConfig {
  id: string;
  provider: string;
  baseUrl: string | null;
  keyHint: string | null;
  authType: "api-key" | "endpoint" | "oauth-cli";
}
export interface ProviderModel {
  provider: string;
  providerName: string;
  id: string;
  displayName: string;
  reasoningEfforts: ReasoningEffort[];
  serviceTiers: ("default" | "fast")[];
  inputModalities: ("text" | "image" | "file")[];
}
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt?: string;
}
export interface CliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  account?: string;
  plan?: string;
  error?: string;
}
export type CliProviderId = "codex" | "claude-code" | "github-copilot";
export interface ConversationSummary {
  id: string;
  title: string | null;
  pinned: boolean;
  agentId: string;
  agentName: string;
  externalId: string | null;
  createdAt: string;
}
export interface ChannelConnector {
  type: string;
  name: string;
  description: string;
  status: "available" | "requires-webhook" | "requires-native-helper" | "planned";
  fields: {
    key: string;
    secretKey?: string;
    configKey?: string;
    label: string;
    placeholder: string;
  }[];
}
export interface ChannelBinding {
  agentId: string;
  agentName: string;
  agentStatus: string;
  type: string;
  credentials: Record<string, { name: string; hint: string | null }>;
}
/**
 * Dashboard wire types. Mirrors of @bridge/spec's schema, kept local so the
 * browser does not ship a validation library — the server is what validates
 * (ADR-0005), and it rejects anything these types would mis-describe.
 */
export interface Widget {
  id: string;
  type: string;
  title?: string;
  source?: string;
  chartType?: "line" | "bar" | "area";
  content?: string;
  url?: string;
  agent?: string;
}
export interface DashboardSection {
  id: string;
  title?: string;
  widgets: Widget[];
}
export interface DashboardPage {
  id: string;
  title: string;
  sections: DashboardSection[];
}
export interface Dashboard {
  version: 1;
  name: string;
  theme?: { accent?: string; background?: string; appearance?: "dark" | "light" | "system" };
  pages: DashboardPage[];
  navigation?: string[];
}
export interface DashboardTemplateSummary {
  id: string;
  name: string;
  description: string;
  pages: number;
  widgets: number;
  dashboard: Dashboard;
}

export type SourceData =
  | { kind: "metric"; value: number; unit?: string }
  | { kind: "series"; points: { label: string; value: number }[]; unit?: string }
  | { kind: "rows"; columns: string[]; rows: (string | number | null)[][] }
  | { kind: "unavailable"; reason: string };

export interface SecretRef {
  id: string;
  name: string;
  hint: string | null;
}
export interface ApiTokenSummary {
  id: string;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}
export interface SearchConfiguration {
  provider: "brave" | "custom";
  endpoint: string;
  apiKeyHint: string | null;
}
/** One thing an agent knows: a point in the graph. */
export interface KnowledgeNode {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  kind: string;
  body: string;
  confidence: string;
  mentions: number;
  sourceRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeEdge {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
}
export interface MemoryEntry {
  id: string;
  agentId: string;
  agentName: string;
  runId: string | null;
  kind: "long-term" | "knowledge";
  content: string;
  createdAt: string;
}
export interface Manifest {
  meta: { name: string; slug: string; description?: string };
  agents: { name: string; instructions: string }[];
  deployment: { target: string; background: boolean };
  [key: string]: unknown;
}

export interface RunSummary {
  id: string;
  status: string;
  trigger: string;
  conversationId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  queuedAt: string;
  finishedAt: string | null;
}
export interface RunStep {
  id: string;
  seq: number;
  type: string;
  agentName: string | null;
  data: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
}
export interface Approval {
  id: string;
  runId: string;
  agentId: string | null;
  agentName: string | null;
  agentTitle: string | null;
  toolName: string;
  action: string;
  input: Record<string, unknown>;
  status: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
}
/**
 * A trigger with a life: where it is in time, and what has happened to it.
 * Derived from an agent's manifest, so it has no create or delete here —
 * adding a schedule means editing the agent.
 */
export interface Automation {
  id: string;
  agentId: string;
  agentName: string | null;
  name: string;
  title: string;
  kind: "cron" | "interval" | "event";
  /** The schedule in words, built server-side so no client parses cron. */
  schedule: string;
  status: "active" | "paused" | "completed" | "disabled";
  statusReason: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runsCount: number;
  consecutiveFailures: number;
  /** The trigger exactly as it is written in the agent's manifest. */
  spec: {
    name: string;
    title?: string;
    cron?: string;
    every?: string;
    timezone?: string;
    input?: string;
    event?: string;
    enabled?: boolean;
    model?: { provider: string; model: string };
    reasoningEffort?: string;
    loop?: { maxRuns?: number; until?: string; maxConsecutiveFailures?: number };
  };
}

/**
 * An edit writes the agent's manifest, so only the trigger's own fields are
 * here. `null` clears a value; omitting a key leaves it alone.
 */
export interface AutomationEdit {
  title?: string | null;
  cron?: string | null;
  every?: string | null;
  timezone?: string | null;
  input?: string | null;
  /** null clears it, which means the workspace default applies again. */
  model?: { provider: string; model: string } | null;
  reasoningEffort?: string | null;
  enabled?: boolean;
  loop?: {
    maxRuns?: number | null;
    until?: string | null;
    maxConsecutiveFailures?: number;
  };
}

export interface ConversationRun {
  id: string;
  status: string;
  trigger: string;
  error: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

export interface RunDetail {
  run: RunSummary & { output: { content?: string } | null; error: string | null };
  steps: RunStep[];
}

export type RunStreamEvent =
  | { type: "delta"; text: string }
  | { type: "step"; step: { type: string; data: unknown } }
  | {
      type: "status";
      status: string;
      output: { content?: string; attachments?: Attachment[] } | null;
    };

async function* runStreamEvents(
  workspaceId: string,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<RunStreamEvent> {
  const res = await fetch(`/api/v1/workspaces/${workspaceId}/runs/${runId}/stream`, {
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body)
    throw new BridgeApiError(res.status, {
      code: "internal",
      message: "could not open the run stream",
    });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseFrame = (frame: string): RunStreamEvent | undefined => {
    const event = frame.match(/^event:\s*(.+)$/m)?.[1];
    const raw = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (!event || !raw) return undefined;

    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (event === "delta") return { type: "delta", text: String(data.text ?? "") };
      if (event === "step") {
        return { type: "step", step: { type: String(data.type), data: data.data } };
      }
      if (event === "status") {
        return {
          type: "status",
          status: String(data.status),
          output: (data.output ?? null) as {
            content?: string;
            attachments?: Attachment[];
          } | null,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }

    const trailing = parseFrame(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

export const api = {
  health: () => get<{ status: string; version: string; checks: { db: string } }>("/health"),

  signup: (email: string, password: string, name?: string, invitationToken?: string) =>
    send<{ user: User; workspace: { id: string } }>("POST", "/v1/auth/signup", {
      email,
      password,
      name,
      invitationToken,
    }),
  login: (email: string, password: string) =>
    send<{ user: User }>("POST", "/v1/auth/login", { email, password }),
  logout: () => send<void>("POST", "/v1/auth/logout"),
  me: () => get<{ user: User }>("/v1/auth/me"),
  sso: () => get<{ sso: { enabled: boolean; name?: string } }>("/v1/auth/sso"),
  apiTokens: () => get<{ tokens: ApiTokenSummary[] }>("/v1/auth/tokens"),
  createApiToken: (name: string, expiresInDays?: number) =>
    send<{ token: ApiTokenSummary & { value: string } }>("POST", "/v1/auth/tokens", {
      name,
      expiresInDays,
    }),
  revokeApiToken: (tokenId: string) => send<void>("DELETE", `/v1/auth/tokens/${tokenId}`),
  invitation: (token: string) =>
    get<{
      invitation: { email: string; role: string; expiresAt: string; workspaceName: string };
    }>(`/v1/auth/invitations/${encodeURIComponent(token)}`),
  acceptInvitation: (token: string) =>
    send<{ workspaceId: string }>(
      "POST",
      `/v1/auth/invitations/${encodeURIComponent(token)}/accept`,
    ),
  rotateSecretKey: () =>
    send<{ rotation: { rotatedSecrets: number; storage: string; warning?: string } }>(
      "POST",
      "/v1/auth/security/rotate-key",
    ),

  workspaces: () => get<{ workspaces: Workspace[] }>("/v1/workspaces"),
  updateWorkspace: (
    workspaceId: string,
    body: {
      name: string;
      description?: string | null;
      timezone?: string | null;
      defaultModel?: { provider: string; model: string } | null;
      defaultReasoning?: string | null;
      allowedPaths?: string[];
    },
  ) => send<{ workspace: Workspace }>("PATCH", `/v1/workspaces/${workspaceId}`, body),
  invitations: (workspaceId: string) =>
    get<{ invitations: WorkspaceInvitation[] }>(`/v1/workspaces/${workspaceId}/invitations`),
  createInvitation: (
    workspaceId: string,
    body: { email: string; role: "admin" | "member"; expiresInDays?: number },
  ) =>
    send<{
      invitation: WorkspaceInvitation & { delivery: "email" | "share-link"; token?: string };
    }>("POST", `/v1/workspaces/${workspaceId}/invitations`, body),
  revokeInvitation: (workspaceId: string, invitationId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/invitations/${invitationId}`),

  templates: () => get<{ templates: TemplateSummary[] }>("/v1/templates"),
  dashboardTemplates: () =>
    get<{ templates: DashboardTemplateSummary[] }>("/v1/templates/dashboards"),

  /** Resolve one dashboard data source. Unknown names 404 by design. */
  data: (workspaceId: string, source: string) =>
    get<{ data: SourceData }>(`/v1/workspaces/${workspaceId}/data/${source}`),
  workspaceDashboard: (workspaceId: string) =>
    get<{ dashboard: Dashboard | null }>(`/v1/workspaces/${workspaceId}/dashboard`),
  updateWorkspaceDashboard: (workspaceId: string, dashboard: Dashboard) =>
    send<{ dashboard: Dashboard }>("PUT", `/v1/workspaces/${workspaceId}/dashboard`, dashboard),
  deleteWorkspaceDashboard: (workspaceId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/dashboard`),

  /**
   * `designer` names the provider and model to design with. The agent's own
   * model is passed where we know it: providers Bridge has no default for —
   * a local Ollama, say — would otherwise refuse with "specify a model".
   */
  draftDashboard: (
    workspaceId: string,
    description: string,
    name?: string,
    designer?: { provider?: string; model?: string },
  ) =>
    send<{ dashboard: Dashboard; attempts: number }>(
      "POST",
      `/v1/workspaces/${workspaceId}/architect/dashboard/draft`,
      { description, name, ...designer },
    ),
  editDashboard: (
    workspaceId: string,
    agentId: string,
    instruction: string,
    designer?: { provider?: string; model?: string },
  ) =>
    send<{ dashboard: Dashboard; attempts: number; current: Dashboard }>(
      "POST",
      `/v1/workspaces/${workspaceId}/architect/agents/${agentId}/dashboard/edit`,
      { instruction, ...designer },
    ),
  editWorkspaceDashboard: (
    workspaceId: string,
    current: Dashboard,
    instruction: string,
    designer?: { provider?: string; model?: string },
  ) =>
    send<{ dashboard: Dashboard; attempts: number; current: Dashboard }>(
      "POST",
      `/v1/workspaces/${workspaceId}/architect/dashboard/edit`,
      { current, instruction, ...designer },
    ),

  agents: (workspaceId: string) =>
    get<{ agents: AgentSummary[] }>(`/v1/workspaces/${workspaceId}/agents`),
  agent: (workspaceId: string, agentId: string) =>
    get<{ agent: { id: string; name: string; status: string; manifest: Manifest } }>(
      `/v1/workspaces/${workspaceId}/agents/${agentId}`,
    ),
  createAgent: (
    workspaceId: string,
    body: { templateId?: string; name?: string; instructions?: string },
  ) =>
    send<{ agent: { id: string; manifest: Manifest } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agents`,
      body,
    ),
  updateAgent: (workspaceId: string, agentId: string, manifest: unknown) =>
    send<{ agent: { id: string; manifest: Manifest } }>(
      "PUT",
      `/v1/workspaces/${workspaceId}/agents/${agentId}`,
      { manifest },
    ),
  deleteAgent: (workspaceId: string, agentId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/agents/${agentId}`),

  deployAgent: (workspaceId: string, agentId: string) =>
    send<{ agent: { id: string; status: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agents/${agentId}/deploy`,
    ),
  stopAgent: (workspaceId: string, agentId: string) =>
    send<{ agent: { id: string; status: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agents/${agentId}/stop`,
    ),

  startRun: (
    workspaceId: string,
    agentId: string,
    input: string,
    options: {
      conversationId?: string;
      attachmentIds?: string[];
      model?: { provider: string; model: string };
      reasoningEffort?: ReasoningEffort;
      fastMode?: boolean;
    } = {},
  ) =>
    send<{ run: { id: string; status: string; conversationId: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agents/${agentId}/runs`,
      { input, ...options },
    ),
  runs: (workspaceId: string, agentId: string) =>
    get<{ runs: RunSummary[] }>(`/v1/workspaces/${workspaceId}/agents/${agentId}/runs`),
  run: (workspaceId: string, runId: string) =>
    get<RunDetail>(`/v1/workspaces/${workspaceId}/runs/${runId}`),
  cancelRun: (workspaceId: string, runId: string) =>
    send<unknown>("POST", `/v1/workspaces/${workspaceId}/runs/${runId}/cancel`),

  draftAgent: (workspaceId: string, description: string, name?: string) =>
    send<{ manifest: Manifest; attempts: number }>(
      "POST",
      `/v1/workspaces/${workspaceId}/architect/draft`,
      { description, name },
    ),
  editAgent: (workspaceId: string, agentId: string, instruction: string) =>
    send<{ manifest: Manifest; attempts: number }>(
      "POST",
      `/v1/workspaces/${workspaceId}/architect/agents/${agentId}/edit`,
      { instruction },
    ),

  conversations: (workspaceId: string) =>
    get<{ conversations: ConversationSummary[] }>(`/v1/workspaces/${workspaceId}/conversations`),
  updateConversation: (
    workspaceId: string,
    conversationId: string,
    body: { title?: string; pinned?: boolean },
  ) =>
    send<{ conversation: Pick<ConversationSummary, "id" | "title" | "pinned"> }>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/conversations/${conversationId}`,
      body,
    ),
  deleteConversation: (workspaceId: string, conversationId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/conversations/${conversationId}`),

  channels: (workspaceId: string) =>
    get<{ connectors: ChannelConnector[]; bindings: ChannelBinding[] }>(
      `/v1/workspaces/${workspaceId}/channels`,
    ),
  connectChannel: (
    workspaceId: string,
    type: string,
    body: { agentId: string; credentials: Record<string, string> },
  ) =>
    send<{ binding: { agentId: string; agentName: string; type: string } }>(
      "PUT",
      `/v1/workspaces/${workspaceId}/channels/${type}`,
      body,
    ),
  disconnectChannel: (workspaceId: string, type: string, agentId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/channels/${type}/${agentId}`),
  conversation: (workspaceId: string, conversationId: string) =>
    get<{
      conversation: { id: string; title: string | null };
      /**
       * What actually happened. A run that failed or is still going has a
       * question and no answer, and the client needs to tell that apart from
       * a conversation nobody has replied to yet.
       */
      runs: ConversationRun[];
      messages: {
        id: string;
        runId: string | null;
        role: string;
        content: string;
        attachments: Attachment[];
      }[];
    }>(`/v1/workspaces/${workspaceId}/conversations/${conversationId}`),

  /**
   * Follow a run's SSE stream. Resolves when the run reaches a terminal state
   * or parks for approval; the callbacks fire as events arrive.
   */
  streamRun: async (
    workspaceId: string,
    runId: string,
    handlers: {
      onDelta: (text: string) => void;
      onStep: (step: { type: string; data: unknown }) => void;
      onStatus: (status: string, output: { content?: string } | null) => void;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    for await (const event of runStreamEvents(workspaceId, runId, signal)) {
      if (event.type === "delta") handlers.onDelta(event.text);
      else if (event.type === "step") handlers.onStep(event.step);
      else handlers.onStatus(event.status, event.output);
    }
  },

  runStream: runStreamEvents,

  approvals: (workspaceId: string, status = "pending") =>
    get<{ approvals: Approval[] }>(`/v1/workspaces/${workspaceId}/approvals?status=${status}`),
  approve: (workspaceId: string, approvalId: string) =>
    send<unknown>("POST", `/v1/workspaces/${workspaceId}/approvals/${approvalId}/approve`),
  deny: (workspaceId: string, approvalId: string, reason?: string) =>
    send<unknown>("POST", `/v1/workspaces/${workspaceId}/approvals/${approvalId}/deny`, { reason }),
  extendApproval: (workspaceId: string, approvalId: string, hours: number) =>
    send<{ approval: { id: string; expiresAt: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/approvals/${approvalId}/extend`,
      { hours },
    ),

  automations: (workspaceId: string, agentId?: string) =>
    get<{ automations: Automation[] }>(
      `/v1/workspaces/${workspaceId}/automations${agentId ? `?agent=${agentId}` : ""}`,
    ),
  automationAction: (
    workspaceId: string,
    automationId: string,
    action: "pause" | "resume" | "run",
  ) => send<unknown>("POST", `/v1/workspaces/${workspaceId}/automations/${automationId}/${action}`),
  /** Writes the agent's manifest, so the change survives the next reconcile. */
  updateAutomation: (workspaceId: string, automationId: string, body: AutomationEdit) =>
    send<{ agent: { id: string } }>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/automations/${automationId}`,
      body,
    ),
  deleteAutomation: (workspaceId: string, automationId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/automations/${automationId}`),

  secrets: (workspaceId: string) =>
    get<{ secrets: SecretRef[] }>(`/v1/workspaces/${workspaceId}/secrets`),
  putSecret: (workspaceId: string, name: string, value: string) =>
    send<{ secret: SecretRef }>("PUT", `/v1/workspaces/${workspaceId}/secrets`, { name, value }),
  deleteSecret: (workspaceId: string, secretId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/secrets/${secretId}`),
  searchConfiguration: (workspaceId: string) =>
    get<{ search: SearchConfiguration | null }>(`/v1/workspaces/${workspaceId}/search`),
  updateSearchConfiguration: (
    workspaceId: string,
    body: { provider: "brave" | "custom"; endpoint?: string; apiKey?: string },
  ) => send<{ search: SearchConfiguration }>("PUT", `/v1/workspaces/${workspaceId}/search`, body),
  deleteSearchConfiguration: (workspaceId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/search`),
  knowledgeGraph: (workspaceId: string, agentId?: string) =>
    get<{ nodes: KnowledgeNode[]; edges: KnowledgeEdge[] }>(
      `/v1/workspaces/${workspaceId}/memory/graph${agentId ? `?agentId=${agentId}` : ""}`,
    ),
  forgetKnowledge: (workspaceId: string, nodeId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/memory/graph/${nodeId}`),
  charter: (workspaceId: string, agentId: string) =>
    get<{ charter: { file: string; content: string }[] }>(
      `/v1/workspaces/${workspaceId}/agents/${agentId}/charter`,
    ),
  saveCharter: (workspaceId: string, agentId: string, file: string, content: string) =>
    send<{ file: string }>(
      "PUT",
      `/v1/workspaces/${workspaceId}/agents/${agentId}/charter/${file}`,
      { content },
    ),
  memories: (workspaceId: string, filters?: { q?: string; agentId?: string; kind?: string }) => {
    const params = new URLSearchParams();
    if (filters?.q) params.set("q", filters.q);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.kind) params.set("kind", filters.kind);
    return get<{ memories: MemoryEntry[] }>(
      `/v1/workspaces/${workspaceId}/memory${params.size ? `?${params}` : ""}`,
    );
  },
  createMemory: (
    workspaceId: string,
    body: { agentId: string; kind: "long-term" | "knowledge"; content: string },
  ) => send<{ memory: MemoryEntry }>("POST", `/v1/workspaces/${workspaceId}/memory`, body),
  deleteMemory: (workspaceId: string, memoryId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/memory/${memoryId}`),

  providers: (workspaceId: string) =>
    get<{ providers: ProviderConfig[] }>(`/v1/workspaces/${workspaceId}/providers`),
  availableProviders: (workspaceId: string) =>
    get<{ providers: string[] }>(`/v1/workspaces/${workspaceId}/providers/available`),
  connectProvider: (
    workspaceId: string,
    body: { provider: string; apiKey?: string; baseUrl?: string },
  ) => send<{ provider: ProviderConfig }>("PUT", `/v1/workspaces/${workspaceId}/providers`, body),
  disconnectProvider: (workspaceId: string, provider: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/providers/${provider}`),
  providerModels: (workspaceId: string) =>
    get<{ models: ProviderModel[] }>(`/v1/workspaces/${workspaceId}/providers/models`),
  cliProviderStatus: (workspaceId: string) =>
    get<{ providers: Record<CliProviderId, CliAuthStatus> }>(
      `/v1/workspaces/${workspaceId}/providers/cli-status`,
    ),
  startProviderOAuth: (workspaceId: string, provider: CliProviderId) =>
    send<{
      connected: boolean;
      launched: boolean;
      command?: string;
      provider?: ProviderConfig;
      status: CliAuthStatus;
    }>("POST", `/v1/workspaces/${workspaceId}/providers/${provider}/oauth/start`),
  finishProviderOAuth: (workspaceId: string, provider: CliProviderId) =>
    send<{ provider: ProviderConfig; status: CliAuthStatus }>(
      "POST",
      `/v1/workspaces/${workspaceId}/providers/${provider}/oauth/connect`,
    ),

  uploadAttachment: (workspaceId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ attachment: Attachment }>(`/v1/workspaces/${workspaceId}/attachments`, {
      method: "POST",
      body: form,
    });
  },
  deleteAttachment: (workspaceId: string, attachmentId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/attachments/${attachmentId}`),
};
