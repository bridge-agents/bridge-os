import { BridgeError } from "@bridge/core";
import { agents } from "@bridge/db";
import { connectedProviders, providerResolver } from "@bridge/runtime";
import type { ChatMessage, Provider } from "@bridge/sdk";
import {
  blankDashboard,
  blankManifest,
  type Dashboard,
  DashboardSchema,
  describeDataSources,
  type Manifest,
  safeParseManifest,
  slugify,
} from "@bridge/spec";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * The Agent Architect: natural language in, a validated Bridge Manifest out.
 *
 * It never edits anything directly. It proposes a complete manifest that the
 * user reviews and saves through the ordinary agent endpoints, so AI editing
 * goes through exactly the same validation as a hand-written change.
 */

/** Sensible default model per provider for design work. */
const ARCHITECT_MODELS: Record<string, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  openrouter: "anthropic/claude-opus-5",
};

const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You design Bridge agents. You reply with ONE JSON object — a Bridge Manifest — and nothing else. No prose, no markdown fences.

The manifest shape:
{
  "specVersion": 1,
  "meta": { "name": string, "slug": lowercase-hyphenated, "description": string },
  "models": {
    "default": { "provider": string, "model": string },
    "roles": { "<roleName>": { "provider": string, "model": string } }
  },
  "agents": [
    {
      "name": lowercase-hyphenated,
      "description": string,
      "instructions": string,
      "model": "<roleName from models.roles>",
      "tools": ["<tool name from the tools array>"],
      "canDelegateTo": ["<other agent name>"]
    }
  ],
  "entryAgent": "<name of the agent that receives user messages>",
  "tools": [{ "name": lowercase-hyphenated, "kind": "native" | "mcp" | "http" | "custom" }],
  "memory": { "longTerm": boolean, "knowledge": boolean },
  "permissions": {
    "default": "allow" | "deny" | "ask",
    "rules": [{ "resource": "tool:<name>", "actions": "*" | [string], "effect": "allow" | "deny" | "ask" }]
  },
  "triggers": {
    "schedules": [{
      "name": lowercase-hyphenated,
      "cron": "<5-field cron>",        // calendar times — use EITHER cron
      "every": "30s" | "5m" | "2h" | "1d",  // OR every, never both
      "timezone": "<IANA zone, e.g. America/New_York>",
      "input": "<the task to run, in plain language>",
      "loop": { "maxRuns": number, "until": "<ISO 8601>", "maxConsecutiveFailures": number }
    }],
    "events": [{ "name": lowercase-hyphenated, "event": "<event type>", "input": string }]
  },
  "deployment": { "target": "local" | "self-hosted" | "cloud", "background": boolean },
  "runtime": {
    "sandbox": {
      "network": "none" | "restricted" | "full",
      "filesystem": "none" | "workspace" | "full",
      "allowedPaths": ["<absolute path or ~/folder the agent may work in>"]
    }
  }
}

Rules you must follow:
- Every name in an agent's "tools" must exist in the top-level "tools" array.
- Every name in "canDelegateTo" must be another agent in "agents".
- An agent's "model" must be a key of "models.roles"; omit it to use models.default.
- "entryAgent" must name one of the agents.
- Only use providers the user has connected.
- Default permissions to "ask" and grant only what the described job needs. Anything that sends, deletes, spends, or publishes stays "ask".
- Prefer the smallest design that does the job: one agent unless the work genuinely splits into distinct roles.
- The "filesystem" tool can read, list, glob, grep, write, edit, mkdir, move and
  delete. Grant it whenever the job involves files. Prefer "edit" (replace an
  exact fragment) over "write" (replace the whole file) when changing something
  that already exists.
- An agent that works on the user's own files needs those folders in
  "runtime.sandbox.allowedPaths" — name the folders rather than setting
  filesystem to "full", which hands over the whole machine.
- Schedules take exactly one of "cron" or "every". Use "every" for "check in on
  something" ("every 15m"); use "cron" for a time of day or day of week ("0 9 * * 1-5"),
  and set "timezone" to the user's, because "9am" means 9am where they are.
- A repeating task that has an end must say so in "loop": "check ten times" is
  maxRuns 10, "until Friday" is an until date. An automation with no ending runs
  and spends until someone stops it, so only leave "loop" off when the user
  really does mean indefinitely.`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1)
    throw new BridgeError("provider_error", "no JSON in the response");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Ask the model for a JSON document, feeding validation errors back until it
 * produces one that parses. The user never sees an invalid proposal — which
 * is the whole guarantee, so the loop is shared rather than reimplemented per
 * document type.
 */
async function proposeJson<T>(options: {
  provider: Provider;
  model: string;
  system: string;
  context: string;
  instruction: string;
  /** Validates a candidate; returning issues asks the model to try again. */
  parse: (value: unknown) => { success: true; data: T } | { success: false; issues: string };
  /** Names the document in error messages, e.g. "manifest". */
  noun: string;
}): Promise<{ value: T; attempts: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: `${options.context}\n\n${options.instruction}` },
  ];

  let lastIssues = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await options.provider.complete({
      model: options.model,
      messages,
      maxTokens: 8000,
    });

    if (result.stopReason === "refusal") {
      throw new BridgeError("provider_error", `the model declined to design this ${options.noun}`);
    }

    try {
      const parsed = options.parse(extractJson(result.message.content));
      if (parsed.success) return { value: parsed.data, attempts: attempt };
      lastIssues = parsed.issues;
    } catch (error) {
      lastIssues = error instanceof Error ? error.message : "unparseable response";
    }

    messages.push(
      { role: "assistant", content: result.message.content },
      {
        role: "user",
        content: `That ${options.noun} is invalid:\n${lastIssues}\n\nReply with the corrected ${options.noun} as one JSON object.`,
      },
    );
  }

  throw new BridgeError(
    "provider_error",
    `the model could not produce a valid ${options.noun}`,
    lastIssues ? [{ path: options.noun, message: lastIssues }] : undefined,
  );
}

const issuesOf = (error: { issues: { path: PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");

async function proposeManifest(options: {
  provider: Provider;
  model: string;
  context: string;
  instruction: string;
}): Promise<{ manifest: Manifest; attempts: number }> {
  const { value, attempts } = await proposeJson<Manifest>({
    ...options,
    system: SYSTEM_PROMPT,
    noun: "manifest",
    parse: (raw) => {
      const parsed = safeParseManifest(raw);
      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, issues: issuesOf(parsed.error) };
    },
  });
  return { manifest: value, attempts };
}

/**
 * Dashboards are generated against the same closed source catalogue the
 * renderer resolves, so the model cannot invent a data binding that silently
 * renders empty.
 */
const DASHBOARD_PROMPT = `You design Bridge dashboards. You reply with ONE JSON object — a Bridge Dashboard — and nothing else. No prose, no markdown fences.

The dashboard shape:
{
  "version": 1,
  "name": string,
  "theme": { "accent": "#RRGGBB", "appearance": "dark" | "light" | "system" },
  "pages": [
    {
      "id": lowercase-hyphenated,
      "title": string,
      "sections": [
        {
          "id": lowercase-hyphenated,
          "title": string,
          "widgets": [ ...widgets ]
        }
      ]
    }
  ]
}

Widgets. Every widget has "id" (lowercase-hyphenated, unique within the page) and an optional "title":
- { "type": "metric", "source": <metric source> }            one big number
- { "type": "chart", "source": <series source>, "chartType": "line" | "bar" | "area" }
- { "type": "table", "source": <rows source> }
- { "type": "activity", "source": "events.recent" }
- { "type": "logs", "source": "logs.recent" }
- { "type": "approvalQueue" }                                 things waiting on a human
- { "type": "agentStatus" }                                   every agent and its state
- { "type": "text", "content": string }                       a note, no data binding

Data sources you may use — these are the only ones that exist:
%SOURCES%

Rules you must follow:
- A "metric" widget must use a metric source, "chart" a series source, "table" a rows source. Using the wrong kind renders an empty panel.
- Never invent a source name. If the user asks for something no source provides, use a "text" widget saying so, or leave it out.
- Widget ids must be unique within their page.
- Put the thing the user cares about most in the first section.
- Prefer few, meaningful panels over many. A dashboard is read at a glance.`;

async function proposeDashboard(options: {
  provider: Provider;
  model: string;
  context: string;
  instruction: string;
}): Promise<{ dashboard: Dashboard; attempts: number }> {
  const { value, attempts } = await proposeJson<Dashboard>({
    ...options,
    system: DASHBOARD_PROMPT.replace("%SOURCES%", describeDataSources()),
    noun: "dashboard",
    parse: (raw) => {
      const parsed = DashboardSchema.safeParse(raw);
      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, issues: issuesOf(parsed.error) };
    },
  });
  return { dashboard: value, attempts };
}

export function architectRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const getProvider = providerResolver(deps.db, deps.secretKey);
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  /** Pick the provider to design with: the caller's choice, else any connected one. */
  const resolveDesigner = async (workspaceId: string, requested?: string, model?: string) => {
    const connected = await connectedProviders(deps.db, workspaceId);
    if (connected.size === 0) {
      throw new BridgeError(
        "validation_failed",
        "connect a model provider before using the architect",
      );
    }

    const providerId =
      requested ??
      [...connected].find((candidate) => candidate in ARCHITECT_MODELS) ??
      [...connected][0];
    if (!providerId || !connected.has(providerId)) {
      throw new BridgeError("validation_failed", `provider "${requested}" is not connected`);
    }

    const chosenModel = model ?? ARCHITECT_MODELS[providerId];
    if (!chosenModel) {
      throw new BridgeError("validation_failed", `specify a model to use with "${providerId}"`);
    }

    return {
      provider: await getProvider(workspaceId, providerId),
      model: chosenModel,
      connected: [...connected],
    };
  };

  /** Design a new agent from a description. */
  app.post("/draft", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        description: z.string().min(1).max(20_000),
        name: z.string().max(120).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
      }),
    );
    const workspaceId = c.get("workspaceId");
    const designer = await resolveDesigner(workspaceId, body.provider, body.model);

    const name = body.name?.trim() || "New Agent";
    const { manifest, attempts } = await proposeManifest({
      provider: designer.provider,
      model: designer.model,
      context: [
        `Connected providers: ${designer.connected.join(", ")}.`,
        `Use "${name}" as meta.name and "${slugify(name)}" as meta.slug.`,
        "Here is the minimal valid manifest for reference:",
        JSON.stringify(blankManifest({ name }), null, 2),
      ].join("\n"),
      instruction: `Design an agent for this request:\n${body.description}`,
    });

    return c.json({ manifest, attempts });
  });

  /** Edit an existing agent in natural language; returns a proposal to review. */
  app.post("/agents/:agentId/edit", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        instruction: z.string().min(1).max(20_000),
        provider: z.string().optional(),
        model: z.string().optional(),
      }),
    );
    const workspaceId = c.get("workspaceId");

    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, c.req.param("agentId"))));
    if (!agent) throw new BridgeError("not_found", "agent not found");

    const designer = await resolveDesigner(workspaceId, body.provider, body.model);
    const { manifest, attempts } = await proposeManifest({
      provider: designer.provider,
      model: designer.model,
      context: [
        `Connected providers: ${designer.connected.join(", ")}.`,
        "This is the agent's current manifest:",
        JSON.stringify(agent.manifest, null, 2),
      ].join("\n"),
      instruction: `Apply this change and return the complete updated manifest:\n${body.instruction}`,
    });

    // Returned, never saved: the user reviews the proposal and PUTs it.
    return c.json({ manifest, attempts, current: agent.manifest });
  });

  /** Design a dashboard from a description. Returns a proposal to review. */
  app.post("/dashboard/draft", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        description: z.string().min(1).max(20_000),
        name: z.string().max(120).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
      }),
    );
    const workspaceId = c.get("workspaceId");
    const designer = await resolveDesigner(workspaceId, body.provider, body.model);

    const { dashboard, attempts } = await proposeDashboard({
      provider: designer.provider,
      model: designer.model,
      context: [
        `Use "${body.name?.trim() || "Dashboard"}" as the dashboard name.`,
        "Here is the minimal valid dashboard for reference:",
        JSON.stringify(blankDashboard(body.name?.trim() || "Dashboard"), null, 2),
      ].join("\n"),
      instruction: `Design a dashboard for this request:\n${body.description}`,
    });

    return c.json({ dashboard, attempts });
  });

  app.post("/dashboard/edit", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        current: DashboardSchema,
        instruction: z.string().min(1).max(20_000),
        provider: z.string().optional(),
        model: z.string().optional(),
      }),
    );
    const designer = await resolveDesigner(c.get("workspaceId"), body.provider, body.model);
    const { dashboard, attempts } = await proposeDashboard({
      provider: designer.provider,
      model: designer.model,
      context: [
        "This is the current workspace dashboard:",
        JSON.stringify(body.current, null, 2),
      ].join("\n"),
      instruction: `Apply this change and return the complete updated dashboard:\n${body.instruction}`,
    });
    return c.json({ dashboard, attempts, current: body.current });
  });

  /**
   * Edit an agent's dashboard in natural language. Like the agent editor it
   * returns a proposal and saves nothing: the user reviews the change and
   * PUTs the manifest through the ordinary endpoint, so an AI edit passes
   * exactly the validation a hand-written one does.
   */
  app.post("/agents/:agentId/dashboard/edit", async (c) => {
    const body = await parseBody(
      c,
      z.object({
        instruction: z.string().min(1).max(20_000),
        provider: z.string().optional(),
        model: z.string().optional(),
      }),
    );
    const workspaceId = c.get("workspaceId");

    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, c.req.param("agentId"))));
    if (!agent) throw new BridgeError("not_found", "agent not found");

    const manifest = agent.manifest as { dashboard?: unknown; meta?: { name?: string } };
    const current = manifest.dashboard ?? blankDashboard(manifest.meta?.name ?? "Dashboard");

    const designer = await resolveDesigner(workspaceId, body.provider, body.model);
    const { dashboard, attempts } = await proposeDashboard({
      provider: designer.provider,
      model: designer.model,
      context: ["This is the current dashboard:", JSON.stringify(current, null, 2)].join("\n"),
      instruction: `Apply this change and return the complete updated dashboard:\n${body.instruction}`,
    });

    return c.json({ dashboard, attempts, current });
  });

  return app;
}

export { proposeDashboard, proposeManifest };
