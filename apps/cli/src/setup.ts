import { CliError } from "./client.js";
import type { CommandContext } from "./commands.js";

/**
 * First-run setup, in place of signing up.
 *
 * Locally there is no account to create, so the only thing Bridge genuinely
 * cannot guess is which model provider you want and its key. Everything else
 * (workspace, starter agent) is provisioned rather than asked about — a
 * question the software can answer itself is a question it should not ask.
 */
interface ProviderChoice {
  id: string;
  label: string;
  /** Local endpoints authenticate with a URL; hosted ones with a key. */
  needsKey: boolean;
  defaultBaseUrl?: string;
  defaultModel: string;
}

const PROVIDERS: ProviderChoice[] = [
  { id: "anthropic", label: "Anthropic (Claude)", needsKey: true, defaultModel: "claude-sonnet-5" },
  { id: "openai", label: "OpenAI", needsKey: true, defaultModel: "gpt-4o" },
  {
    id: "openrouter",
    label: "OpenRouter",
    needsKey: true,
    defaultModel: "anthropic/claude-sonnet-5",
  },
  {
    id: "ollama",
    label: "Ollama (local models, no key)",
    needsKey: false,
    defaultBaseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
  },
];

const bold = (text: string) => `[1m${text}[0m`;
const dim = (text: string) => `[2m${text}[0m`;

interface ProviderRow {
  provider: string;
}
interface AgentRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * Is this install ready to talk to? A deployed agent is the test, not a
 * connected provider: setup can be interrupted halfway (or a deploy can fail),
 * and "you have a provider but nothing to chat with" must still be fixable by
 * running Bridge again rather than dead-ending on `no deployed agents`.
 */
export async function needsSetup(ctx: CommandContext, workspaceId: string): Promise<boolean> {
  const { agents } = await ctx.client.get<{ agents: AgentRow[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );
  return !agents.some((agent) => agent.status === "deployed");
}

/** Providers already connected, so setup can skip questions it can answer. */
async function connectedProviders(ctx: CommandContext, workspaceId: string): Promise<string[]> {
  const { providers } = await ctx.client.get<{ providers: ProviderRow[] }>(
    `/v1/workspaces/${workspaceId}/providers`,
  );
  return providers.map((provider) => provider.provider);
}

async function ask(ctx: CommandContext, question: string, fallback = ""): Promise<string> {
  if (!ctx.prompt) throw new CliError("setup needs an interactive terminal");
  const answer = (await ctx.prompt(question)).trim();
  return answer || fallback;
}

/**
 * Walk a new install to a deployed agent. Returns the agent to start talking
 * to, so the caller can drop straight into a conversation.
 */
export async function runSetup(ctx: CommandContext, workspaceId: string): Promise<AgentRow> {
  const already = await connectedProviders(ctx, workspaceId);

  ctx.out(`\n${bold("Welcome to Bridge.")}`);
  ctx.out(dim("Everything runs on this machine. Two questions and you're set.\n"));

  // Resuming an interrupted setup: the provider is already connected, so pick
  // up from there rather than asking for the key a second time.
  let choice: ProviderChoice;
  if (already.length > 0) {
    const known = PROVIDERS.find((provider) => already.includes(provider.id));
    choice = known ?? ({ ...PROVIDERS[0], id: already[0] } as ProviderChoice);
    ctx.out(dim(`Using the ${choice.id} provider you already connected.`));
  } else {
    for (const [index, provider] of PROVIDERS.entries()) {
      ctx.out(`  ${index + 1}. ${provider.label}`);
    }

    const pick = await ask(ctx, `\nWhich model provider? ${dim("[1]")} `, "1");
    const picked = PROVIDERS[Number(pick) - 1];
    if (!picked) throw new CliError(`"${pick}" is not one of the options.`);
    choice = picked;

    const body: { provider: string; apiKey?: string; baseUrl?: string } = { provider: choice.id };
    if (choice.needsKey) {
      body.apiKey = await ask(ctx, `Paste your ${choice.label} API key: `);
      if (!body.apiKey) throw new CliError("that provider needs an API key to work");
    } else {
      body.baseUrl = await ask(
        ctx,
        `Endpoint ${dim(`[${choice.defaultBaseUrl}]`)} `,
        choice.defaultBaseUrl,
      );
    }

    await ctx.client.request(`/v1/workspaces/${workspaceId}/providers`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    ctx.out(dim(`Connected ${choice.id}.`));
  }

  const model = await ask(ctx, `Model ${dim(`[${choice.defaultModel}]`)} `, choice.defaultModel);

  // A starter agent, so the very next thing you do is talk to something.
  // Reuse one left behind by an interrupted setup instead of stacking copies.
  const existing = await ctx.client.get<{ agents: AgentRow[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );
  const agent = existing.agents[0]
    ? { id: existing.agents[0].id }
    : (
        await ctx.client.post<{ agent: { id: string } }>(`/v1/workspaces/${workspaceId}/agents`, {
          templateId: "personal-assistant",
        })
      ).agent;

  // Templates name a provider of their own, and roles ("fast", …) can name
  // others. Only one provider is connected at this point, so repoint every
  // reference — otherwise deploy refuses with "connect these providers first".
  const current = await ctx.client.get<{ agent: { manifest: Record<string, unknown> } }>(
    `/v1/workspaces/${workspaceId}/agents/${agent.id}`,
  );
  const manifest = current.agent.manifest;
  const models = manifest.models as { default: unknown; roles?: Record<string, unknown> };
  models.default = { provider: choice.id, model };
  for (const role of Object.keys(models.roles ?? {})) {
    (models.roles as Record<string, unknown>)[role] = { provider: choice.id, model };
  }

  await ctx.client.request(`/v1/workspaces/${workspaceId}/agents/${agent.id}`, {
    method: "PUT",
    body: JSON.stringify({ manifest }),
  });
  await ctx.client.post(`/v1/workspaces/${workspaceId}/agents/${agent.id}/deploy`);

  const { agents } = await ctx.client.get<{ agents: AgentRow[] }>(
    `/v1/workspaces/${workspaceId}/agents`,
  );
  const ready = agents.find((candidate) => candidate.id === agent.id);
  if (!ready) throw new CliError("setup finished but the agent is missing");

  ctx.out(dim(`Deployed "${ready.name}". You're ready.\n`));
  return ready;
}
