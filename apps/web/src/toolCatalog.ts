import type { Manifest } from "./api.js";

/**
 * What an agent can be given.
 *
 * Two kinds sit in one list because the distinction is ours, not yours:
 * `native` tools are built into Bridge and need nothing but a switch, while
 * `mcp` connectors are servers Bridge speaks to on your behalf and need a
 * token first. The catalog is deliberately honest about which is which —
 * a connector that cannot work yet says so rather than failing after you
 * have pasted a key into it.
 */
export type ToolKind = "native" | "mcp";

export interface ToolCatalogEntry {
  /** Grant name written into the agent's manifest. */
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  category: "Built in" | "Work" | "Developer" | "Data" | "Sales" | "Productivity";
  /**
   * Remote MCP endpoint. Present means Bridge can connect it from here;
   * absent on connectors whose vendor has no remote server yet.
   */
  url?: string;
  /** The credential to collect, if any. Absent means nothing to paste. */
  credential?: { label: string; hint?: string };
  /** Set when a connector needs something Bridge cannot do yet. */
  unavailable?: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // ── Built into Bridge ────────────────────────────────────────────────
  {
    id: "filesystem",
    name: "Files",
    description:
      "Read, search, write and edit files in the agent's workspace and any folders you allow above.",
    kind: "native",
    category: "Built in",
  },
  {
    id: "web-search",
    name: "Web search",
    description: "Search the web and read back titles, links and snippets.",
    kind: "native",
    category: "Built in",
  },
  {
    id: "http",
    name: "HTTP requests",
    description: "Call any HTTP API directly. Requests that change data ask first.",
    kind: "native",
    category: "Built in",
  },
  {
    id: "shell",
    name: "Shell",
    description: "Run commands in the agent's own workspace directory.",
    kind: "native",
    category: "Built in",
  },

  // ── Work ─────────────────────────────────────────────────────────────
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, search, draft and send mail.",
    kind: "mcp",
    category: "Work",
    unavailable: "Needs Google sign-in, which Bridge cannot do yet",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Read your schedule and create events.",
    kind: "mcp",
    category: "Work",
    unavailable: "Needs Google sign-in, which Bridge cannot do yet",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Find and read documents and spreadsheets.",
    kind: "mcp",
    category: "Work",
    unavailable: "Needs Google sign-in, which Bridge cannot do yet",
  },
  {
    id: "outlook",
    name: "Outlook",
    description: "Microsoft 365 mail and calendar.",
    kind: "mcp",
    category: "Work",
    unavailable: "Needs Microsoft sign-in, which Bridge cannot do yet",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read channels, search history and post messages.",
    kind: "mcp",
    category: "Work",
    url: "https://mcp.slack.com/mcp",
    credential: { label: "Bot token", hint: "xoxb-… from your Slack app's OAuth page" },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and write pages and databases.",
    kind: "mcp",
    category: "Work",
    url: "https://mcp.notion.com/mcp",
    credential: { label: "Integration token", hint: "From notion.so/my-integrations" },
  },
  {
    id: "asana",
    name: "Asana",
    description: "Tasks, projects and assignments.",
    kind: "mcp",
    category: "Work",
    url: "https://mcp.asana.com/sse",
    credential: { label: "Personal access token" },
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Issues, boards and documentation.",
    kind: "mcp",
    category: "Work",
    url: "https://mcp.atlassian.com/v1/sse",
    credential: { label: "API token", hint: "From id.atlassian.com API tokens" },
  },
  {
    id: "zoom",
    name: "Zoom",
    description: "Meetings, recordings and summaries.",
    kind: "mcp",
    category: "Work",
    unavailable: "Needs Zoom sign-in, which Bridge cannot do yet",
  },

  // ── Developer ────────────────────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and code search.",
    kind: "mcp",
    category: "Developer",
    url: "https://api.githubcopilot.com/mcp/",
    credential: { label: "Personal access token", hint: "ghp_… with repo scope" },
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Projects, merge requests and pipelines.",
    kind: "mcp",
    category: "Developer",
    url: "https://gitlab.com/api/v4/mcp",
    credential: { label: "Personal access token" },
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Errors, releases and issue detail.",
    kind: "mcp",
    category: "Developer",
    url: "https://mcp.sentry.dev/mcp",
    credential: { label: "Auth token" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers, DNS records and analytics.",
    kind: "mcp",
    category: "Developer",
    url: "https://observability.mcp.cloudflare.com/sse",
    credential: { label: "API token" },
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Deployments, projects and logs.",
    kind: "mcp",
    category: "Developer",
    url: "https://mcp.vercel.com",
    credential: { label: "Access token" },
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, cycles and project status.",
    kind: "mcp",
    category: "Developer",
    url: "https://mcp.linear.app/sse",
    credential: { label: "API key", hint: "From Linear settings → API" },
  },

  // ── Data ─────────────────────────────────────────────────────────────
  {
    id: "supabase",
    name: "Supabase",
    description: "Query tables, inspect schema and manage projects.",
    kind: "mcp",
    category: "Data",
    url: "https://mcp.supabase.com/mcp",
    credential: {
      label: "Personal access token",
      hint: "From supabase.com/dashboard/account/tokens",
    },
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read and query any Postgres database directly.",
    kind: "mcp",
    category: "Data",
    unavailable: "Needs a local MCP server, which this build cannot launch yet",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Bases, tables and records.",
    kind: "mcp",
    category: "Data",
    unavailable: "Needs a local MCP server, which this build cannot launch yet",
  },
  {
    id: "snowflake",
    name: "Snowflake",
    description: "Warehouse queries and schema.",
    kind: "mcp",
    category: "Data",
    unavailable: "Needs a local MCP server, which this build cannot launch yet",
  },

  // ── Sales ────────────────────────────────────────────────────────────
  {
    id: "shopify",
    name: "Shopify",
    description: "Products, orders, customers and inventory.",
    kind: "mcp",
    category: "Sales",
    url: "https://mcp.shopify.com/mcp",
    credential: { label: "Admin API access token", hint: "shpat_… from your custom app" },
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Payments, customers, subscriptions and invoices.",
    kind: "mcp",
    category: "Sales",
    url: "https://mcp.stripe.com",
    credential: { label: "Secret key", hint: "sk_live_… or sk_test_…" },
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Contacts, companies and deals.",
    kind: "mcp",
    category: "Sales",
    url: "https://mcp.hubspot.com/anthropic",
    credential: { label: "Private app token" },
  },
  {
    id: "salesforce",
    name: "Salesforce",
    description: "Accounts, opportunities and reports.",
    kind: "mcp",
    category: "Sales",
    unavailable: "Needs Salesforce sign-in, which Bridge cannot do yet",
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Conversations, contacts and help articles.",
    kind: "mcp",
    category: "Sales",
    url: "https://mcp.intercom.com/mcp",
    credential: { label: "Access token" },
  },
  {
    id: "square",
    name: "Square",
    description: "Payments, catalog and orders.",
    kind: "mcp",
    category: "Sales",
    url: "https://mcp.squareup.com/sse",
    credential: { label: "Access token" },
  },

  // ── Productivity ─────────────────────────────────────────────────────
  {
    id: "figma",
    name: "Figma",
    description: "Read designs, components and variables.",
    kind: "mcp",
    category: "Productivity",
    url: "https://mcp.figma.com/mcp",
    credential: { label: "Personal access token" },
  },
  {
    id: "canva",
    name: "Canva",
    description: "Designs, folders and exports.",
    kind: "mcp",
    category: "Productivity",
    unavailable: "Needs Canva sign-in, which Bridge cannot do yet",
  },
  {
    id: "monday",
    name: "monday.com",
    description: "Boards, items and updates.",
    kind: "mcp",
    category: "Productivity",
    url: "https://mcp.monday.com/sse",
    credential: { label: "API token" },
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Tasks, projects and due dates.",
    kind: "mcp",
    category: "Productivity",
    url: "https://ai.todoist.net/mcp",
    credential: { label: "API token" },
  },
];

export const TOOL_CATEGORIES = [
  "Built in",
  "Work",
  "Developer",
  "Data",
  "Sales",
  "Productivity",
] as const;

/** Grant names already on an agent's entry. */
export function grantedTools(manifest: Manifest | undefined): string[] {
  return (manifest?.tools ?? []).map((tool) => tool.name);
}

/**
 * Add a tool to an agent's manifest.
 *
 * The manifest stays the single definition of the agent (invariant 1), so
 * connecting a tool here is an edit to it and nothing else — the same edit
 * you could make by hand, which is why it survives a redeploy.
 */
export function withTool(
  manifest: Manifest,
  entry: ToolCatalogEntry,
  secretName?: string,
): Manifest {
  const next = structuredClone(manifest);
  if (!grantedTools(next).includes(entry.id)) {
    next.tools = [
      ...next.tools,
      entry.kind === "native"
        ? { name: entry.id, kind: "native", config: {} }
        : {
            name: entry.id,
            kind: "mcp",
            config: { url: entry.url },
            ...(secretName ? { secretBindings: { "headers.authorization": secretName } } : {}),
          },
    ];
  }

  /**
   * Every agent in the manifest that can already use tools gets the new one;
   * an agent that lists none was deliberately left without any. The secret
   * is listed on each of them too, because the manifest requires an agent to
   * name every secret it may resolve — a grant alone does not open the safe.
   */
  next.agents = next.agents.map((agent) => {
    if (agent.tools.length === 0) return agent;
    return {
      ...agent,
      tools: agent.tools.includes(entry.id) ? agent.tools : [...agent.tools, entry.id],
      ...(secretName && !agent.secrets.includes(secretName)
        ? { secrets: [...agent.secrets, secretName] }
        : {}),
    };
  });

  return next;
}

/** The secret name a connector's credential is stored under. */
export const toolSecretName = (id: string) => `tool-${id}`;

/** Remove a tool grant and everything that referenced it. */
export function withoutTool(manifest: Manifest, toolId: string): Manifest {
  const next = structuredClone(manifest);
  next.tools = next.tools.filter((tool) => tool.name !== toolId);
  next.agents = next.agents.map((agent) => ({
    ...agent,
    tools: agent.tools.filter((tool) => tool !== toolId),
  }));
  // A rule about a tool nobody has is clutter that outlives its subject.
  next.permissions = {
    ...next.permissions,
    rules: next.permissions.rules.filter((rule) => rule.resource !== `tool:${toolId}`),
  };
  return next;
}

/**
 * The actions of a native tool that change nothing.
 *
 * This is what lets "let it look, but ask before it changes anything" be a
 * single choice rather than a checklist. Only native tools appear here: Bridge
 * knows what its own actions do, and cannot know whether some MCP server's
 * `update_record` is reversible.
 */
export const SAFE_ACTIONS: Record<string, string[]> = {
  filesystem: ["read", "list", "glob", "grep", "mkdir"],
  http: ["read"],
  "web-search": ["search"],
};

export type ToolAccess = "ask" | "safe" | "allow" | "deny";

export const ACCESS_LABELS: Record<ToolAccess, { title: string; hint: string }> = {
  ask: { title: "Ask me every time", hint: "Nothing happens without your say-so." },
  safe: {
    title: "Look freely, ask before changing",
    hint: "Reading and searching run on their own; anything that changes something asks first.",
  },
  allow: { title: "Always allow", hint: "Runs without asking, including changes." },
  deny: { title: "Never allow", hint: "Blocked outright, even if the agent tries." },
};

/** How a tool is currently governed, read back from the manifest's rules. */
export function toolAccess(manifest: Manifest, toolId: string): ToolAccess {
  const rules = manifest.permissions.rules.filter((rule) => rule.resource === `tool:${toolId}`);
  const wildcard = rules.find((rule) => rule.actions === "*");
  if (wildcard?.effect === "deny") return "deny";
  if (wildcard?.effect === "allow") return "allow";
  return rules.some((rule) => rule.effect === "allow") ? "safe" : "ask";
}

/**
 * Rewrite one tool's rules to a chosen level.
 *
 * Rules for the tool are replaced rather than appended to: first match wins,
 * so leaving an old rule in front of a new one would silently keep the old
 * answer and make the setting appear not to work.
 */
export function withToolAccess(manifest: Manifest, toolId: string, access: ToolAccess): Manifest {
  const next = structuredClone(manifest);
  const others = next.permissions.rules.filter((rule) => rule.resource !== `tool:${toolId}`);
  const resource = `tool:${toolId}`;

  const added: Manifest["permissions"]["rules"] =
    access === "allow"
      ? [{ resource, actions: "*", effect: "allow" }]
      : access === "deny"
        ? [{ resource, actions: "*", effect: "deny" }]
        : access === "safe" && SAFE_ACTIONS[toolId]
          ? [{ resource, actions: SAFE_ACTIONS[toolId] as string[], effect: "allow" }]
          : [];

  next.permissions = { ...next.permissions, rules: [...added, ...others] };
  return next;
}
