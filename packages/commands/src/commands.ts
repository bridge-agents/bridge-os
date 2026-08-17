import {
  type Cell,
  type CommandContext,
  type CommandDef,
  CommandError,
  type CommandResult,
} from "./types.js";

/**
 * The command catalogue.
 *
 * Everything here goes through `/v1` endpoints, which is what lets the same
 * definition run from a terminal and from the chat box. If a command needs
 * something the API cannot do, the fix is an endpoint, not a shortcut.
 */
interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

interface AutomationSummary {
  id: string;
  name: string;
  agentName: string | null;
  kind: string;
  schedule: string;
  status: string;
  statusReason: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  runsCount: number;
}

interface RunSummary {
  id: string;
  status: string;
  trigger: string;
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  queuedAt: string;
  finishedAt: string | null;
}

interface ApprovalSummary {
  id: string;
  agentTitle: string | null;
  agentName: string;
  toolName: string;
  action: string;
  status: string;
}

const ws = (ctx: CommandContext, path: string) => `/v1/workspaces/${ctx.workspaceId}${path}`;

/** Agents by slug, id, or name — people type whichever they remember. */
async function findAgent(ctx: CommandContext, reference: string): Promise<AgentSummary> {
  const { agents } = await ctx.request<{ agents: AgentSummary[] }>(ws(ctx, "/agents"));
  const needle = reference.toLowerCase();
  const agent = agents.find(
    (candidate) =>
      candidate.slug.toLowerCase() === needle ||
      candidate.id === reference ||
      candidate.name.toLowerCase() === needle,
  );
  if (!agent) {
    const known = agents.map((a) => a.slug).join(", ") || "none yet";
    throw new CommandError(`No agent called "${reference}". You have: ${known}.`);
  }
  return agent;
}

async function findAutomation(ctx: CommandContext, reference: string): Promise<AutomationSummary> {
  const { automations } = await ctx.request<{ automations: AutomationSummary[] }>(
    ws(ctx, "/automations"),
  );
  const needle = reference.toLowerCase();
  const found = automations.find(
    (candidate) => candidate.name.toLowerCase() === needle || candidate.id === reference,
  );
  if (!found) {
    const known = automations.map((a) => a.name).join(", ") || "none yet";
    throw new CommandError(`No automation called "${reference}". You have: ${known}.`);
  }
  return found;
}

const when = (value: string | null): string =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
    : "—";

const money = (value: string | null): string =>
  value === null ? "—" : `$${Number(value).toFixed(Number(value) < 0.01 ? 4 : 2)}`;

export const commands: CommandDef[] = [
  {
    name: "help",
    summary: "List everything Bridge can do",
    group: "workspace",
    async run(): Promise<CommandResult> {
      // Built from the catalogue itself, so a new command is documented by
      // existing rather than by someone remembering to write it down.
      return {
        table: {
          columns: ["command", "what it does"],
          rows: commands.map((command) => [
            `${command.name}${(command.args ?? [])
              .map((arg) => (arg.required ? ` <${arg.name}>` : ` [${arg.name}]`))
              .join("")}`,
            command.summary,
          ]),
        },
      };
    },
  },

  {
    name: "status",
    summary: "Health, agents, and what is waiting on you",
    group: "workspace",
    async run(ctx) {
      const [health, { agents }, { approvals }, { automations }] = await Promise.all([
        ctx.request<{ status: string; version: string }>("/health"),
        ctx.request<{ agents: AgentSummary[] }>(ws(ctx, "/agents")),
        ctx.request<{ approvals: ApprovalSummary[] }>(ws(ctx, "/approvals")),
        ctx.request<{ automations: AutomationSummary[] }>(ws(ctx, "/automations")),
      ]);

      const deployed = agents.filter((agent) => agent.status === "deployed").length;
      const active = automations.filter((a) => a.status === "active").length;
      const stuck = automations.filter((a) => a.status === "disabled").length;

      const lines = [
        `Bridge ${health.version} — ${health.status}`,
        `${agents.length} agent${agents.length === 1 ? "" : "s"}, ${deployed} deployed`,
        `${active} automation${active === 1 ? "" : "s"} running`,
      ];
      if (stuck > 0)
        lines.push(`${stuck} automation${stuck === 1 ? "" : "s"} stopped after failures`);
      if (approvals.length > 0) lines.push(`${approvals.length} waiting for your approval`);
      return { text: lines.join("\n") };
    },
  },

  {
    name: "agents",
    summary: "List your agents",
    group: "agents",
    async run(ctx) {
      const { agents } = await ctx.request<{ agents: AgentSummary[] }>(ws(ctx, "/agents"));
      if (!agents.length) return { text: "No agents yet. Create one on the Agents page." };
      return {
        table: {
          columns: ["agent", "status"],
          rows: agents.map((agent) => [agent.slug, agent.status]),
        },
      };
    },
  },

  {
    name: "deploy",
    summary: "Deploy an agent so it can run",
    group: "agents",
    args: [{ name: "agent", description: "Agent slug", required: true, suggest: "agent" }],
    async run(ctx, args) {
      const agent = await findAgent(ctx, args.agent as string);
      await ctx.request(ws(ctx, `/agents/${agent.id}/deploy`), { method: "POST" });
      return { text: `Deployed ${agent.slug}.`, changed: true };
    },
  },

  {
    name: "stop",
    summary: "Stop an agent — its schedules stop with it",
    group: "agents",
    destructive: true,
    args: [{ name: "agent", description: "Agent slug", required: true, suggest: "agent" }],
    async run(ctx, args) {
      const agent = await findAgent(ctx, args.agent as string);
      await ctx.request(ws(ctx, `/agents/${agent.id}/stop`), { method: "POST" });
      return { text: `Stopped ${agent.slug}. Its automations will not fire.`, changed: true };
    },
  },

  {
    name: "run",
    summary: "Send an agent a task",
    group: "runs",
    args: [
      { name: "agent", description: "Agent slug", required: true, suggest: "agent" },
      { name: "task", description: "What to do", required: true, rest: true },
    ],
    async run(ctx, args) {
      const agent = await findAgent(ctx, args.agent as string);
      const { run } = await ctx.request<{ run: { id: string; conversationId: string } }>(
        ws(ctx, `/agents/${agent.id}/runs`),
        { method: "POST", body: { input: args.task } },
      );
      return {
        text: `Started ${agent.slug}.`,
        navigate: `/chat?agent=${agent.id}&conversation=${run.conversationId}`,
        changed: true,
      };
    },
  },

  {
    name: "runs",
    summary: "Recent runs for an agent",
    group: "runs",
    args: [{ name: "agent", description: "Agent slug", required: true, suggest: "agent" }],
    async run(ctx, args) {
      const agent = await findAgent(ctx, args.agent as string);
      const { runs } = await ctx.request<{ runs: RunSummary[] }>(
        ws(ctx, `/agents/${agent.id}/runs`),
      );
      if (!runs.length) return { text: `${agent.slug} has not run yet.` };
      return {
        table: {
          columns: ["run", "status", "trigger", "cost", "started"],
          rows: runs
            .slice(0, 20)
            .map((run) => [
              run.id,
              run.status,
              run.trigger,
              money(run.costUsd),
              when(run.queuedAt),
            ]),
        },
      };
    },
  },

  {
    name: "cancel",
    summary: "Stop a run that is going",
    group: "runs",
    destructive: true,
    args: [{ name: "run", description: "Run id", required: true, suggest: "run" }],
    async run(ctx, args) {
      await ctx.request(ws(ctx, `/runs/${args.run}/cancel`), { method: "POST" });
      return { text: `Cancelling ${args.run}.`, changed: true };
    },
  },

  {
    name: "usage",
    summary: "What your agents have spent today",
    group: "workspace",
    async run(ctx) {
      const [cost, tokens, count] = await Promise.all([
        ctx.request<{ data: { value: number } }>(ws(ctx, "/data/runs.cost.total")),
        ctx.request<{ data: { value: number } }>(ws(ctx, "/data/runs.tokens.total")),
        ctx.request<{ data: { value: number } }>(ws(ctx, "/data/runs.total")),
      ]);
      return {
        text: [
          `${count.data.value} run${count.data.value === 1 ? "" : "s"}`,
          `${tokens.data.value.toLocaleString()} tokens`,
          `$${cost.data.value.toFixed(2)}`,
        ].join(" · "),
      };
    },
  },

  {
    name: "automations",
    summary: "Every schedule and trigger, and when it next runs",
    group: "automations",
    async run(ctx) {
      const { automations } = await ctx.request<{ automations: AutomationSummary[] }>(
        ws(ctx, "/automations"),
      );
      if (!automations.length) {
        return {
          text: "No automations yet. Add a schedule to an agent and it will appear here.",
        };
      }
      return {
        table: {
          columns: ["automation", "agent", "when", "status", "next", "runs"],
          rows: automations.map((row) => [
            row.name,
            row.agentName,
            row.schedule,
            row.statusReason ? `${row.status} (${row.statusReason})` : row.status,
            when(row.nextRunAt),
            row.runsCount,
          ]),
        },
      };
    },
  },

  {
    name: "pause",
    summary: "Pause an automation without deleting it",
    group: "automations",
    args: [
      { name: "automation", description: "Automation name", required: true, suggest: "automation" },
    ],
    async run(ctx, args) {
      const found = await findAutomation(ctx, args.automation as string);
      await ctx.request(ws(ctx, `/automations/${found.id}/pause`), { method: "POST" });
      return {
        text: `Paused "${found.name}". It will not fire until you resume it.`,
        changed: true,
      };
    },
  },

  {
    name: "resume",
    summary: "Start a paused or stopped automation again",
    group: "automations",
    args: [
      { name: "automation", description: "Automation name", required: true, suggest: "automation" },
    ],
    async run(ctx, args) {
      const found = await findAutomation(ctx, args.automation as string);
      await ctx.request(ws(ctx, `/automations/${found.id}/resume`), { method: "POST" });
      return { text: `Resumed "${found.name}".`, changed: true, navigate: "/automations" };
    },
  },

  {
    name: "trigger",
    summary: "Run an automation now, without waiting for its schedule",
    group: "automations",
    args: [
      { name: "automation", description: "Automation name", required: true, suggest: "automation" },
    ],
    async run(ctx, args) {
      const found = await findAutomation(ctx, args.automation as string);
      const { run } = await ctx.request<{ run: { id: string } }>(
        ws(ctx, `/automations/${found.id}/run`),
        { method: "POST" },
      );
      // Deliberately does not move the schedule: testing an automation must
      // not change when it next fires on its own.
      return { text: `Running "${found.name}" now (${run.id}).`, changed: true };
    },
  },

  {
    name: "approvals",
    summary: "What is waiting for your decision",
    group: "approvals",
    async run(ctx) {
      const { approvals } = await ctx.request<{ approvals: ApprovalSummary[] }>(
        ws(ctx, "/approvals"),
      );
      if (!approvals.length) return { text: "Nothing is waiting on you." };
      return {
        table: {
          columns: ["approval", "agent", "wants to"],
          rows: approvals.map((approval) => [
            approval.id,
            approval.agentTitle ?? approval.agentName,
            `${approval.toolName}: ${approval.action}`,
          ]),
        },
      };
    },
  },

  {
    name: "approve",
    summary: "Let a paused run continue",
    group: "approvals",
    args: [{ name: "approval", description: "Approval id", required: true, suggest: "approval" }],
    async run(ctx, args) {
      await ctx.request(ws(ctx, `/approvals/${args.approval}/approve`), { method: "POST" });
      return { text: "Approved — the run is continuing.", changed: true };
    },
  },

  {
    name: "deny",
    summary: "Refuse an action, with a reason the agent will read",
    group: "approvals",
    args: [
      { name: "approval", description: "Approval id", required: true, suggest: "approval" },
      { name: "reason", description: "Why not", rest: true },
    ],
    async run(ctx, args) {
      await ctx.request(ws(ctx, `/approvals/${args.approval}/deny`), {
        method: "POST",
        body: args.reason ? { reason: args.reason } : {},
      });
      return { text: "Denied. The agent has been told why.", changed: true };
    },
  },

  {
    name: "doctor",
    summary: "Check why something is not working",
    group: "workspace",
    async run(ctx) {
      const [health, providers, { agents }, { automations }] = await Promise.all([
        ctx.request<{ status: string; checks: { db: string } }>("/health"),
        ctx.request<{ providers: { provider: string; ok: boolean; error?: string }[] }>(
          ws(ctx, "/providers/health"),
        ),
        ctx.request<{ agents: AgentSummary[] }>(ws(ctx, "/agents")),
        ctx.request<{ automations: AutomationSummary[] }>(ws(ctx, "/automations")),
      ]);

      /**
       * Ordered worst-first. Someone runs this because something is broken,
       * so the broken thing goes at the top rather than under a list of
       * everything that is fine.
       */
      const rows: Cell[][] = [];
      for (const provider of providers.providers) {
        rows.push([
          provider.ok ? "ok" : "FAILING",
          `provider: ${provider.provider}`,
          provider.ok ? "reachable" : (provider.error ?? "unreachable"),
        ]);
      }
      for (const automation of automations.filter((a) => a.status === "disabled")) {
        rows.push(["FAILING", `automation: ${automation.name}`, automation.statusReason ?? ""]);
      }
      if (!providers.providers.length) {
        rows.push(["FAILING", "providers", "none connected — add one on the Providers page"]);
      }
      if (!agents.some((agent) => agent.status === "deployed")) {
        rows.push(["warn", "agents", "none deployed, so nothing can run"]);
      }
      rows.push(["ok", "bridge", `${health.status}, database ${health.checks.db}`]);

      rows.sort((a, b) => Number(b[0] === "FAILING") - Number(a[0] === "FAILING"));
      return { table: { columns: ["", "what", "detail"], rows } };
    },
  },

  {
    name: "providers",
    summary: "Model providers this workspace can use",
    group: "workspace",
    async run(ctx) {
      const { providers } = await ctx.request<{
        providers: { provider: string; hint: string | null; baseUrl: string | null }[];
      }>(ws(ctx, "/providers"));
      if (!providers.length) return { text: "No providers connected yet." };
      return {
        table: {
          columns: ["provider", "credential"],
          rows: providers.map((provider) => [
            provider.provider,
            provider.hint ?? provider.baseUrl ?? "connected",
          ]),
        },
      };
    },
  },
];
