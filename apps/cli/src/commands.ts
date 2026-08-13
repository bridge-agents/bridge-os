import { ApiClient, type CliConfig, CliError, saveConfig } from "./client.js";
import { ensureWeb, openBrowser } from "./serve.js";
import { needsSetup, runSetup } from "./setup.js";

/**
 * Command implementations, kept free of process/stdout details so they can be
 * driven directly in tests against an in-memory API.
 */
export interface CommandContext {
  config: CliConfig;
  client: ApiClient;
  out: (line: string) => void;
  /** Reads a line from the user; only interactive commands use it. */
  prompt?: (question: string) => Promise<string>;
}

const bold = (text: string) => `[1m${text}[0m`;
const dim = (text: string) => `[2m${text}[0m`;

/**
 * The workspace to act in.
 *
 * Locally there is exactly one and nobody signed in to pick it, so ask the
 * API rather than making the user run `bridge login` to learn something the
 * server already knows. Cached on the context so one command asks once.
 */
export async function ensureWorkspace(ctx: CommandContext): Promise<string> {
  if (ctx.config.workspaceId) return ctx.config.workspaceId;

  const { workspaces } = await ctx.client.get<{ workspaces: { id: string }[] }>("/v1/workspaces");
  const workspaceId = workspaces[0]?.id;
  if (!workspaceId) throw new CliError("no workspace available — run `bridge login` first");

  ctx.config.workspaceId = workspaceId;
  return workspaceId;
}

interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}
interface RunSummary {
  id: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  queuedAt: string;
}
interface ApprovalSummary {
  id: string;
  toolName: string;
  action: string;
  agentTitle: string | null;
  input: Record<string, unknown>;
}

/** Sign in and remember the token and default workspace. */
export async function login(ctx: CommandContext, email: string, password: string): Promise<void> {
  const { token } = await ctx.client.post<{ token: string }>("/v1/auth/login", { email, password });

  const authed = new ApiClient({ apiUrl: ctx.config.apiUrl, token });
  const { workspaces } = await authed.get<{ workspaces: { id: string; name: string }[] }>(
    "/v1/workspaces",
  );
  const workspace = workspaces[0];

  await saveConfig({ apiUrl: ctx.config.apiUrl, token, workspaceId: workspace?.id });
  ctx.out(`Signed in. Workspace: ${workspace?.name ?? "(none)"}`);
}

export async function status(ctx: CommandContext): Promise<void> {
  const health = await ctx.client.get<{ status: string; version: string; checks: { db: string } }>(
    "/health",
  );
  ctx.out(
    `${bold("Bridge")} ${health.version} — ${health.status} ${dim(`db:${health.checks.db}`)}`,
  );

  if (!ctx.config.token) {
    ctx.out(dim("Not signed in. Run `bridge login <email>`."));
    return;
  }

  const workspaceId = await ensureWorkspace(ctx);
  const [{ agents }, { approvals }] = await Promise.all([
    ctx.client.get<{ agents: AgentSummary[] }>(`/v1/workspaces/${workspaceId}/agents`),
    ctx.client.get<{ approvals: ApprovalSummary[] }>(`/v1/workspaces/${workspaceId}/approvals`),
  ]);

  const deployed = agents.filter((agent) => agent.status === "deployed").length;
  ctx.out(`${agents.length} agent(s), ${deployed} deployed`);
  if (approvals.length > 0) {
    ctx.out(`${approvals.length} approval(s) waiting — run \`bridge approvals\``);
  }
}

export async function listAgents(ctx: CommandContext): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const { agents } = await ctx.client.get<{ agents: AgentSummary[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );

  if (agents.length === 0) return ctx.out("No agents yet.");
  for (const agent of agents) {
    ctx.out(`${agent.slug.padEnd(24)} ${agent.status.padEnd(10)} ${dim(agent.id)}`);
  }
}

/** Resolve an agent by slug or id so commands can take either. */
async function findAgent(ctx: CommandContext, reference: string): Promise<AgentSummary> {
  const workspaceId = await ensureWorkspace(ctx);
  const { agents } = await ctx.client.get<{ agents: AgentSummary[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );

  const agent = agents.find(
    (candidate) => candidate.slug === reference || candidate.id === reference,
  );
  if (!agent) throw new CliError(`no agent named "${reference}"`);
  return agent;
}

/** No agent named on the command line: fall back to the first deployed one. */
async function defaultAgent(ctx: CommandContext): Promise<AgentSummary> {
  const workspaceId = await ensureWorkspace(ctx);
  const { agents } = await ctx.client.get<{ agents: AgentSummary[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );

  const agent = agents.find((candidate) => candidate.status === "deployed");
  if (!agent) throw new CliError("no deployed agents — run `bridge agent list`");
  return agent;
}

/**
 * Send one task and follow it live. Shared by `run` and `chat` — the only
 * difference is whether the conversation carries over.
 */
async function sendAndFollow(
  ctx: CommandContext,
  agent: AgentSummary,
  input: string,
  conversationId?: string,
): Promise<{ conversationId: string; status: string }> {
  const workspaceId = await ensureWorkspace(ctx);
  const { run } = await ctx.client.post<{
    run: { id: string; conversationId: string };
  }>(`/v1/workspaces/${workspaceId}/agents/${agent.id}/runs`, {
    input,
    ...(conversationId ? { conversationId } : {}),
  });

  let finalStatus = "unknown";
  let wroteText = false;

  for await (const event of ctx.client.stream(
    `/v1/workspaces/${workspaceId}/runs/${run.id}/stream`,
  )) {
    if (event.event === "delta") {
      process.stdout.write(String(event.data.text ?? ""));
      wroteText = true;
    } else if (event.event === "step") {
      const data = (event.data.data ?? {}) as Record<string, unknown>;
      // Show side effects; model calls are already visible as streamed text.
      if (event.data.type === "tool_call") {
        ctx.out(dim(`\n  ⚙ ${String(data.tool)} (${data.executed ? "ran" : "skipped"})`));
      } else if (event.data.type === "delegation") {
        ctx.out(dim(`\n  ↳ delegated to ${String(data.to)}`));
      }
    } else if (event.event === "status") {
      finalStatus = String(event.data.status ?? "unknown");
      const output = event.data.output as { content?: string } | null;
      // Without deltas (no streaming adapter) the answer arrives at the end.
      if (!wroteText && output?.content) process.stdout.write(output.content);
      if (event.data.error) ctx.out(`\nError: ${String(event.data.error)}`);
    }
  }

  if (wroteText || finalStatus === "succeeded") process.stdout.write("\n");
  if (finalStatus === "waiting_approval") {
    ctx.out(dim("Paused for approval — run `bridge approvals` to decide."));
  }
  return { conversationId: run.conversationId, status: finalStatus };
}

export async function runAgent(
  ctx: CommandContext,
  reference: string,
  input: string,
): Promise<void> {
  await sendAndFollow(ctx, await findAgent(ctx, reference), input);
}

/** Interactive REPL against one agent, holding a single conversation. */
export async function conversation(ctx: CommandContext, agent: AgentSummary): Promise<void> {
  if (!ctx.prompt) throw new CliError("chat needs an interactive terminal");

  ctx.out(`${bold(agent.name)} ${dim("— empty line or Ctrl-C to leave")}`);
  let conversationId: string | undefined;

  while (true) {
    const input = (await ctx.prompt("\nyou › ")).trim();
    if (!input) break;

    const result = await sendAndFollow(ctx, agent, input, conversationId);
    conversationId = result.conversationId;
  }
}

/** Chat with a named agent, or the first deployed one. */
export async function chat(ctx: CommandContext, reference?: string): Promise<void> {
  if (!ctx.prompt) throw new CliError("chat needs an interactive terminal");
  return conversation(ctx, reference ? await findAgent(ctx, reference) : await defaultAgent(ctx));
}

export async function listRuns(ctx: CommandContext, reference: string): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const agent = await findAgent(ctx, reference);
  const { runs } = await ctx.client.get<{ runs: RunSummary[] }>(
    `/v1/workspaces/${workspaceId}/agents/${agent.id}/runs`,
  );

  if (runs.length === 0) return ctx.out("No runs yet.");
  for (const run of runs) {
    const cost = run.costUsd ? `$${Number(run.costUsd).toFixed(4)}` : "—";
    ctx.out(
      `${run.status.padEnd(16)} ${String(run.inputTokens + run.outputTokens).padStart(7)} tok  ${cost.padStart(9)}  ${dim(run.id)}`,
    );
  }
}

/** Print a run's trace — the CLI equivalent of the web run inspector. */
export async function logs(ctx: CommandContext, runId: string): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const { run, steps } = await ctx.client.get<{
    run: { status: string; error: string | null; output: { content?: string } | null };
    steps: { seq: number; type: string; agentName: string | null; data: Record<string, unknown> }[];
  }>(`/v1/workspaces/${workspaceId}/runs/${runId}`);

  ctx.out(`${bold(run.status)}${run.error ? ` — ${run.error}` : ""}`);
  for (const step of steps) {
    const detail =
      step.type === "tool_call"
        ? `${String(step.data.tool)} ${step.data.executed ? "ran" : "skipped"}`
        : step.type === "delegation"
          ? `→ ${String(step.data.to)}`
          : String(step.data.stopReason ?? "");
    ctx.out(`${String(step.seq).padStart(3)}. ${step.type.padEnd(12)} ${dim(detail)}`);
  }
  if (run.output?.content) ctx.out(`\n${run.output.content}`);
}

export async function listApprovals(ctx: CommandContext): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const { approvals } = await ctx.client.get<{ approvals: ApprovalSummary[] }>(
    `/v1/workspaces/${workspaceId}/approvals`,
  );

  if (approvals.length === 0) return ctx.out("Nothing waiting.");
  for (const approval of approvals) {
    ctx.out(
      `${bold(approval.toolName)} (${approval.action}) — ${approval.agentTitle ?? "agent"}\n  ${JSON.stringify(approval.input)}\n  ${dim(approval.id)}`,
    );
  }
}

export async function decideApproval(
  ctx: CommandContext,
  approvalId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const path = `/v1/workspaces/${workspaceId}/approvals/${approvalId}/${approved ? "approve" : "deny"}`;

  await ctx.client.post(path, approved ? undefined : { reason });
  ctx.out(approved ? "Approved — the run resumes." : "Denied.");
}

/**
 * `bridge tui` — the whole product in one command: start Bridge if it isn't
 * running, walk first-run setup if this is a new install, then talk to your
 * agent. Nothing to sign into, nothing to configure first.
 */
export async function tui(ctx: CommandContext, reference?: string): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);

  if (await needsSetup(ctx, workspaceId)) {
    const agent = await runSetup(ctx, workspaceId);
    return conversation(ctx, agent);
  }
  return chat(ctx, reference);
}

/** `bridge dashboard` — same setup guarantee, then open the browser. */
export async function dashboard(ctx: CommandContext): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);

  if (ctx.prompt && (await needsSetup(ctx, workspaceId))) {
    await runSetup(ctx, workspaceId);
  }

  const url = await ensureWeb(ctx.out);
  ctx.out(`Bridge dashboard: ${bold(url)}`);
  openBrowser(url);
}
