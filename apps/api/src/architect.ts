import { BridgeError } from "@bridge/core";
import { agents } from "@bridge/db";
import { connectedProviders, providerResolver } from "@bridge/runtime";
import type { ChatMessage, Provider } from "@bridge/sdk";
import { blankManifest, type Manifest, safeParseManifest, slugify } from "@bridge/spec";
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
  "triggers": { "schedules": [{ "name": string, "cron": string, "timezone": string, "input": string }], "events": [] },
  "deployment": { "target": "local" | "self-hosted" | "cloud", "background": boolean }
}

Rules you must follow:
- Every name in an agent's "tools" must exist in the top-level "tools" array.
- Every name in "canDelegateTo" must be another agent in "agents".
- An agent's "model" must be a key of "models.roles"; omit it to use models.default.
- "entryAgent" must name one of the agents.
- Only use providers the user has connected.
- Default permissions to "ask" and grant only what the described job needs. Anything that sends, deletes, spends, or publishes stays "ask".
- Prefer the smallest design that does the job: one agent unless the work genuinely splits into distinct roles.`;

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
 * Ask the model for a manifest, feeding validation errors back until it
 * produces one that parses. The user never sees an invalid proposal.
 */
async function proposeManifest(options: {
  provider: Provider;
  model: string;
  context: string;
  instruction: string;
}): Promise<{ manifest: Manifest; attempts: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
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
      throw new BridgeError("provider_error", "the model declined to design this agent");
    }

    try {
      const parsed = safeParseManifest(extractJson(result.message.content));
      if (parsed.success) return { manifest: parsed.data, attempts: attempt };
      lastIssues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
    } catch (error) {
      lastIssues = error instanceof Error ? error.message : "unparseable response";
    }

    messages.push(
      { role: "assistant", content: result.message.content },
      {
        role: "user",
        content: `That manifest is invalid:\n${lastIssues}\n\nReply with the corrected manifest as one JSON object.`,
      },
    );
  }

  throw new BridgeError(
    "provider_error",
    "the model could not produce a valid manifest",
    lastIssues ? [{ path: "manifest", message: lastIssues }] : undefined,
  );
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

  return app;
}

export { proposeManifest };
