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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: ApiError }).error;
    throw new BridgeApiError(res.status, error ?? { code: "internal", message: res.statusText });
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
}
export interface SecretRef {
  id: string;
  name: string;
  hint: string | null;
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
}
export interface RunDetail {
  run: RunSummary & { output: { content?: string } | null; error: string | null };
  steps: RunStep[];
}

export const api = {
  health: () => get<{ status: string; version: string; checks: { db: string } }>("/health"),

  signup: (email: string, password: string, name?: string) =>
    send<{ user: User; workspace: { id: string } }>("POST", "/v1/auth/signup", {
      email,
      password,
      name,
    }),
  login: (email: string, password: string) =>
    send<{ user: User }>("POST", "/v1/auth/login", { email, password }),
  logout: () => send<void>("POST", "/v1/auth/logout"),
  me: () => get<{ user: User }>("/v1/auth/me"),

  workspaces: () => get<{ workspaces: Workspace[] }>("/v1/workspaces"),

  templates: () => get<{ templates: TemplateSummary[] }>("/v1/templates"),

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

  startRun: (workspaceId: string, agentId: string, input: string, conversationId?: string) =>
    send<{ run: { id: string; status: string; conversationId: string } }>(
      "POST",
      `/v1/workspaces/${workspaceId}/agents/${agentId}/runs`,
      { input, conversationId },
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

  conversation: (workspaceId: string, conversationId: string) =>
    get<{
      conversation: { id: string; title: string | null };
      messages: { id: string; role: string; content: string }[];
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
  ): Promise<void> => {
    const res = await fetch(`/api/v1/workspaces/${workspaceId}/runs/${runId}/stream`, {
      credentials: "include",
    });
    if (!res.ok || !res.body)
      throw new BridgeApiError(res.status, {
        code: "internal",
        message: "could not open the run stream",
      });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are blank-line separated; keep the trailing partial frame.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event:\s*(.+)$/m)?.[1];
        const raw = frame.match(/^data:\s*(.+)$/m)?.[1];
        if (!event || !raw) continue;

        try {
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (event === "delta") handlers.onDelta(String(data.text ?? ""));
          else if (event === "step") {
            handlers.onStep({ type: String(data.type), data: data.data });
          } else if (event === "status") {
            handlers.onStatus(
              String(data.status),
              (data.output ?? null) as { content?: string } | null,
            );
          }
        } catch {
          // Ignore anything that is not a JSON payload.
        }
      }
    }
  },

  approvals: (workspaceId: string, status = "pending") =>
    get<{ approvals: Approval[] }>(`/v1/workspaces/${workspaceId}/approvals?status=${status}`),
  approve: (workspaceId: string, approvalId: string) =>
    send<unknown>("POST", `/v1/workspaces/${workspaceId}/approvals/${approvalId}/approve`),
  deny: (workspaceId: string, approvalId: string, reason?: string) =>
    send<unknown>("POST", `/v1/workspaces/${workspaceId}/approvals/${approvalId}/deny`, { reason }),

  secrets: (workspaceId: string) =>
    get<{ secrets: SecretRef[] }>(`/v1/workspaces/${workspaceId}/secrets`),
  putSecret: (workspaceId: string, name: string, value: string) =>
    send<{ secret: SecretRef }>("PUT", `/v1/workspaces/${workspaceId}/secrets`, { name, value }),
  deleteSecret: (workspaceId: string, secretId: string) =>
    send<void>("DELETE", `/v1/workspaces/${workspaceId}/secrets/${secretId}`),

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
};
