import { availableCommands, findCommand, parseCommand } from "@bridge/commands";
import { banner, chatHelp } from "./banner.js";
import { ApiClient, type CliConfig, CliError, saveConfig } from "./client.js";
import { chatPrompt, readLine, type Suggestion, suggestionsFor } from "./prompt.js";
import { renderResult, spinner } from "./render.js";
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

interface ApiTokenSummary {
  id: string;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** Manage programmatic credentials without reusing a browser session token. */
export async function tokens(
  ctx: CommandContext,
  action: "list" | "create" | "revoke",
  value?: string,
): Promise<void> {
  if (action === "list") {
    const { tokens: rows } = await ctx.client.get<{ tokens: ApiTokenSummary[] }>("/v1/auth/tokens");
    if (rows.length === 0) {
      ctx.out("No active API tokens.");
      return;
    }
    for (const token of rows) {
      ctx.out(
        `${token.id}  ${token.name}  expires ${token.expiresAt ? token.expiresAt.slice(0, 10) : "never"}`,
      );
    }
    return;
  }
  if (!value?.trim())
    throw new CliError(`usage: bridge token ${action} <${action === "create" ? "name" : "id"}>`);
  if (action === "create") {
    const { token } = await ctx.client.post<{ token: ApiTokenSummary & { value: string } }>(
      "/v1/auth/tokens",
      { name: value.trim(), expiresInDays: 90 },
    );
    ctx.out(`API token created. Copy it now; it will not be shown again.\n${token.value}`);
    return;
  }
  await ctx.client.request(`/v1/auth/tokens/${encodeURIComponent(value)}`, { method: "DELETE" });
  ctx.out("API token revoked.");
}

/** Invite someone to the current workspace and print the one-time share link when needed. */
export async function invite(
  ctx: CommandContext,
  email: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  const workspaceId = await ensureWorkspace(ctx);
  const { invitation } = await ctx.client.post<{
    invitation: { delivery: "email" | "share-link"; token?: string };
  }>(`/v1/workspaces/${workspaceId}/invitations`, { email, role });
  if (invitation.delivery === "email") {
    ctx.out(`Invitation sent to ${email}.`);
    return;
  }
  if (!invitation.token) throw new CliError("Bridge did not return an invitation token");
  const origin = new URL(ctx.config.apiUrl).origin;
  ctx.out(
    `Invitation created for ${email}.\n${origin}/?invite=${encodeURIComponent(invitation.token)}`,
  );
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
  model?: { provider: string; model: string },
): Promise<{ conversationId: string; status: string }> {
  const workspaceId = await ensureWorkspace(ctx);
  const { run } = await ctx.client.post<{
    run: { id: string; conversationId: string };
  }>(`/v1/workspaces/${workspaceId}/agents/${agent.id}/runs`, {
    input,
    ...(conversationId ? { conversationId } : {}),
    ...(model ? { model } : {}),
  });

  let finalStatus = "unknown";
  let wroteText = false;
  const startedAt = Date.now();
  // Cleared by the first thing worth looking at, whatever that turns out to be.
  let waiting: { stop: () => void } | undefined = spinner("thinking");
  const settle = () => {
    waiting?.stop();
    waiting = undefined;
  };

  for await (const event of ctx.client.stream(
    `/v1/workspaces/${workspaceId}/runs/${run.id}/stream`,
  )) {
    if (event.event === "delta") {
      settle();
      process.stdout.write(String(event.data.text ?? ""));
      wroteText = true;
    } else if (event.event === "step") {
      const data = (event.data.data ?? {}) as Record<string, unknown>;
      // Show side effects; model calls are already visible as streamed text.
      if (event.data.type === "tool_call") {
        settle();
        const failed = data.ok === false;
        ctx.out(dim(`  ${failed ? "✗" : "·"} ${String(data.tool)} ${String(data.action ?? "")}`));
        if (failed && data.error) ctx.out(dim(`    ${String(data.error)}`));
        waiting = spinner("working");
      } else if (event.data.type === "delegation") {
        settle();
        ctx.out(dim(`  → ${String(data.to)}`));
        waiting = spinner("working");
      }
    } else if (event.event === "status") {
      settle();
      finalStatus = String(event.data.status ?? "unknown");
      const output = event.data.output as {
        content?: string;
        attachments?: { name: string; sizeBytes: number }[];
      } | null;
      // Without deltas (no streaming adapter) the answer arrives at the end.
      if (!wroteText && output?.content) process.stdout.write(output.content);
      // A terminal cannot show a picture, but it can say the file is there.
      for (const file of output?.attachments ?? []) {
        ctx.out(dim(`\n  ⏏ ${file.name} (${Math.max(1, Math.round(file.sizeBytes / 1024))} KB)`));
      }
      if (event.data.error) ctx.out(`\nError: ${String(event.data.error)}`);
    }
  }
  settle();

  if (wroteText || finalStatus === "succeeded") process.stdout.write("\n");
  if (finalStatus === "succeeded") {
    ctx.out(dim(`  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`));
  }
  if (finalStatus === "waiting_approval") {
    ctx.out(dim("  Paused for approval — /approvals to decide."));
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

/**
 * Interactive chat against one agent.
 *
 * A line beginning with "/" is a Bridge command rather than a message — the
 * same catalogue the web chat box runs, so anything you can do there you can
 * do here. Everything else goes to the agent.
 */
export async function conversation(ctx: CommandContext, agent: AgentSummary): Promise<void> {
  if (!ctx.prompt) throw new CliError("chat needs an interactive terminal");

  const workspaceId = await ensureWorkspace(ctx);
  const model = await defaultModelOf(ctx, agent).catch(() => undefined);
  ctx.out(banner({ agent: agent.name, model }));

  let current = agent;
  /**
   * Pick up the thread rather than starting a new one.
   *
   * The terminal and the dashboard are two windows onto the same
   * conversations, so opening the terminal should continue what you were last
   * saying, wherever you said it — `/new` is how you ask for a blank one.
   */
  let conversationId = await latestConversation(ctx, workspaceId, current.id);
  const resumed = conversationId ? await conversationTitle(ctx, workspaceId, conversationId) : "";
  ctx.out(
    resumed
      ? dim(`  Continuing “${resumed}”. /new starts a fresh one, /help lists everything.\n`)
      : dim("  Type / to see the commands, or just say something.\n"),
  );

  /** Chosen with /model; overrides whatever the agent would use. */
  let chosenModel: { provider: string; model: string } | undefined;

  while (true) {
    const input = (await readChatLine(ctx, current.slug)).trim();
    // An empty line leaves, which is also what a closed stdin produces —
    // without this a piped or ended input spins forever.
    if (!input || input === "/exit" || input === "/quit") break;

    if (input.startsWith("/")) {
      const handled = await chatCommand(ctx, input, {
        workspaceId,
        agent: current,
        setAgent: (next) => {
          current = next;
          conversationId = undefined;
          ctx.out(dim(`Now talking to ${next.name}.`));
        },
        newConversation: () => {
          conversationId = undefined;
          ctx.out(dim("Started a new conversation."));
        },
        resumeConversation: (id, title) => {
          conversationId = id;
          ctx.out(dim(`Continuing “${title}”.`));
        },
        setModel: (next) => {
          chosenModel = next;
          ctx.out(
            dim(
              next ? `Now using ${next.model} (${next.provider}).` : "Back to the default model.",
            ),
          );
        },
      });
      if (handled) continue;
    }

    const result = await sendAndFollow(ctx, current, input, conversationId, chosenModel);
    conversationId = result.conversationId;
  }
}

/**
 * Commands the palette offers: the ones that only exist while chatting,
 * then the shared catalogue the web chat box runs too.
 */
const paletteCommands = (): Suggestion[] => [
  { name: "help", summary: "everything you can type" },
  { name: "model", summary: "list models, or switch to one" },
  { name: "new", summary: "start a fresh conversation" },
  { name: "chats", summary: "recent conversations with this agent" },
  { name: "resume", summary: "continue one of them" },
  { name: "agent", summary: "switch to another agent" },
  { name: "exit", summary: "leave the chat" },
  ...availableCommands("cli").map((command) => ({
    name: command.name,
    summary: command.summary,
  })),
];

/**
 * Read one line of chat, with the command palette live under the cursor.
 *
 * Falls back to the plain prompt when stdin is not a terminal, which is what
 * the tests and any piped input use — a palette needs somewhere to draw.
 */
async function readChatLine(ctx: CommandContext, slug: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!ctx.prompt) throw new CliError("chat needs an interactive terminal");
    return ctx.prompt(`\n${dim(slug)} › `);
  }
  process.stdout.write("\n");
  const commands = paletteCommands();
  const { text } = await readLine({
    prompt: chatPrompt(slug),
    suggest: (line) => suggestionsFor(line, commands),
  });
  return text ?? "";
}

interface ConversationRow {
  id: string;
  title: string | null;
  agentId: string;
  createdAt: string;
}

async function recentConversations(
  ctx: CommandContext,
  workspaceId: string,
  agentId?: string,
): Promise<ConversationRow[]> {
  const { conversations } = await ctx.client
    .get<{ conversations: ConversationRow[] }>(`/v1/workspaces/${workspaceId}/conversations`)
    .catch(() => ({ conversations: [] as ConversationRow[] }));
  return agentId ? conversations.filter((row) => row.agentId === agentId) : conversations;
}

const latestConversation = async (ctx: CommandContext, workspaceId: string, agentId: string) =>
  (await recentConversations(ctx, workspaceId, agentId))[0]?.id;

async function conversationTitle(
  ctx: CommandContext,
  workspaceId: string,
  conversationId: string,
): Promise<string> {
  const found = (await recentConversations(ctx, workspaceId)).find(
    (row) => row.id === conversationId,
  );
  return found?.title?.trim() || "your last conversation";
}

/** `/chats` — the same threads the dashboard sidebar shows. */
async function listChats(ctx: CommandContext, session: ChatSession): Promise<void> {
  const rows = (await recentConversations(ctx, session.workspaceId, session.agent.id)).slice(0, 10);
  if (!rows.length) {
    ctx.out(dim("No conversations with this agent yet."));
    return;
  }
  ctx.out(bold("  Recent conversations"));
  rows.forEach((row, index) => {
    const when = new Date(row.createdAt).toLocaleString();
    ctx.out(
      `    ${String(index + 1).padStart(2)}. ${(row.title ?? "Untitled").slice(0, 46).padEnd(48)}${dim(when)}`,
    );
  });
  ctx.out(dim("\n  /resume <number>    continue one    ·    /new    start a fresh one"));
}

/** The model an agent uses when nothing overrides it — shown in the banner. */
async function defaultModelOf(ctx: CommandContext, agent: AgentSummary): Promise<string> {
  const workspaceId = await ensureWorkspace(ctx);
  const { agent: full } = await ctx.client.get<{
    agent: { manifest: { models?: { default?: { provider?: string; model?: string } } } };
  }>(`/v1/workspaces/${workspaceId}/agents/${agent.id}`);
  const model = full.manifest.models?.default;
  return model?.model ? `${model.model} (${model.provider})` : "no default model";
}

interface ChatSession {
  workspaceId: string;
  agent: AgentSummary;
  setAgent: (agent: AgentSummary) => void;
  newConversation: () => void;
  resumeConversation: (conversationId: string, title: string) => void;
  setModel: (model: { provider: string; model: string } | undefined) => void;
}

/**
 * Run a slash command typed while chatting. Returns false when the input was
 * not a command anyone knows, so it can still be sent as a message — a
 * message that happens to start with "/" should not vanish.
 */
async function chatCommand(
  ctx: CommandContext,
  input: string,
  session: ChatSession,
): Promise<boolean> {
  const [verb, ...rest] = input.slice(1).split(/\s+/);

  // A bare "/" is someone asking what there is, which is exactly /help.
  if (!verb) {
    ctx.out(chatHelp(availableCommands("cli").map((c) => ({ name: c.name, summary: c.summary }))));
    return true;
  }
  if (verb === "model") {
    await chooseModel(ctx, session, rest.join(" "));
    return true;
  }
  if (verb === "help" || verb === "?") {
    ctx.out(chatHelp(availableCommands("cli").map((c) => ({ name: c.name, summary: c.summary }))));
    return true;
  }
  if (verb === "new" || verb === "clear") {
    session.newConversation();
    return true;
  }
  if (verb === "chats" || verb === "conversations") {
    await listChats(ctx, session);
    return true;
  }
  if (verb === "resume") {
    const rows = await recentConversations(ctx, session.workspaceId, session.agent.id);
    const chosen = rows[Number(rest[0]) - 1];
    if (!chosen) {
      ctx.out(dim("Which one? Type /chats to see them."));
      return true;
    }
    session.resumeConversation(chosen.id, chosen.title ?? "Untitled");
    return true;
  }
  if (verb === "agent" && rest.length) {
    session.setAgent(await findAgent(ctx, rest.join(" ")));
    return true;
  }
  if (verb === "runs" && !rest.length) {
    // Bare /runs means "this agent", which is the only one you could mean.
    return runShared(ctx, `runs ${session.agent.slug}`, session.workspaceId);
  }

  return runShared(ctx, input.slice(1), session.workspaceId);
}

interface ModelChoice {
  id: string;
  provider: string;
  label?: string;
}

/**
 * `/model` — see what is connected, or switch.
 *
 * With no argument it lists; with one it matches on the model id or a
 * provider-qualified name. Listing first matters because nobody remembers
 * the exact id of a model they connected a week ago.
 */
async function chooseModel(
  ctx: CommandContext,
  session: ChatSession,
  requested: string,
): Promise<void> {
  const { models } = await ctx.client.get<{ models: ModelChoice[] }>(
    `/v1/workspaces/${session.workspaceId}/providers/models`,
  );

  if (!requested) {
    if (!models.length) {
      ctx.out(dim("No models available. Connect a provider first."));
      return;
    }
    ctx.out(bold("  Models you can use"));
    for (const model of models) {
      ctx.out(`    ${model.id.padEnd(34)}${dim(model.provider)}`);
    }
    ctx.out(dim("\n  /model <id>      switch    ·    /model default    use the agent's own"));
    return;
  }

  if (requested === "default" || requested === "reset") {
    session.setModel(undefined);
    return;
  }

  const needle = requested.toLowerCase();
  const match =
    models.find((model) => model.id.toLowerCase() === needle) ??
    models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === needle) ??
    models.find((model) => model.id.toLowerCase().includes(needle));

  if (!match) {
    ctx.out(dim(`No model matching "${requested}". Type /model to see what is connected.`));
    return;
  }
  session.setModel({ provider: match.provider, model: match.id });
}

/** Execute a shared command and print it; false if there is no such command. */
async function runShared(
  ctx: CommandContext,
  input: string,
  workspaceId: string,
): Promise<boolean> {
  if (!findCommand(input)) {
    ctx.out(dim(`No command "/${input.split(" ")[0]}". Type /help to see them.`));
    return true;
  }
  try {
    const { command, args } = parseCommand(input);
    const result = await command.run(
      {
        workspaceId,
        request: (path, init) =>
          ctx.client.request(path, {
            ...(init?.method ? { method: init.method } : {}),
            ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          }),
      },
      args,
    );
    renderResult(result, ctx.out);
  } catch (error) {
    ctx.out(error instanceof Error ? error.message : String(error));
  }
  return true;
}

/** Chat with a named agent, or the first deployed one. */
export async function chat(ctx: CommandContext, reference?: string): Promise<void> {
  if (!ctx.prompt) throw new CliError("chat needs an interactive terminal");
  return conversation(ctx, reference ? await findAgent(ctx, reference) : await defaultAgent(ctx));
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

  const url = await ensureWeb(ctx.config.apiUrl, ctx.out);
  ctx.out(`Bridge dashboard: ${bold(url)}`);
  openBrowser(url);
}
