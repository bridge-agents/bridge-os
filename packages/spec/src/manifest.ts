import { z } from "zod";
import { ModelRefSchema, SlugSchema } from "./common.js";
import { DashboardSchema } from "./dashboard.js";
import { PermissionPolicySchema } from "./permissions.js";

/**
 * The Bridge Manifest (Bridge Agent Specification): the single canonical,
 * declarative description of an agent system. Templates, blank creation, and
 * AI-generated agents all compile into this. See ADR-0002.
 */
export const SPEC_VERSION = 1;

export const AgentDefSchema = z.object({
  name: SlugSchema,
  description: z.string().optional(),
  instructions: z.string().min(1),
  /** Named model role from `models.roles`; omitted → `models.default`. */
  model: z.string().optional(),
  /** Tool grant names from the manifest's `tools` list. */
  tools: z.array(z.string()).default([]),
  /** Agent names this agent may spawn/delegate to as subagents. */
  canDelegateTo: z.array(z.string()).default([]),
  memory: z
    .object({
      working: z.boolean().default(true),
      longTerm: z.boolean().default(false),
    })
    .prefault({}),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

export const ToolGrantSchema = z.object({
  name: SlugSchema,
  kind: z.enum(["native", "mcp", "http", "custom"]),
  config: z.record(z.string(), z.unknown()).prefault({}),
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

export const ScheduleTriggerSchema = z.object({
  name: SlugSchema,
  cron: z.string().min(1),
  timezone: z.string().default("UTC"),
  /** Agent to run; omitted → entry agent. */
  agent: z.string().optional(),
  /** Natural-language task input for the scheduled run. */
  input: z.string().optional(),
});

export const EventTriggerSchema = z.object({
  name: SlugSchema,
  /** Event type this trigger subscribes to (see events.ts catalog). */
  event: z.string().min(1),
  agent: z.string().optional(),
});

export const ChannelBindingSchema = z.object({
  /** Channel adapter type, e.g. "telegram", "discord". */
  type: SlugSchema,
  config: z.record(z.string(), z.unknown()).prefault({}),
});

/**
 * Where the agent executes. This is the ONLY target-specific field in a
 * manifest: everything else is portable, so "Run on this device" → "Move to
 * Bridge Cloud" is a one-field change, not a recreation (ADR-0008).
 */
export const DeploymentTargetSchema = z.enum(["local", "self-hosted", "cloud"]);
export type DeploymentTarget = z.infer<typeof DeploymentTargetSchema>;

export const DeploymentSchema = z.object({
  target: DeploymentTargetSchema.default("local"),
  /**
   * Whether the agent keeps running when the Bridge window is closed.
   * Honoured by the desktop runtime subject to OS limits and user settings.
   */
  background: z.boolean().default(false),
});

export const RuntimeConfigSchema = z.object({
  limits: z
    .object({
      maxConcurrentRuns: z.number().int().positive().default(1),
      maxRunSeconds: z.number().int().positive().default(900),
      dailyTokenBudget: z.number().int().positive().optional(),
      dailySpendUsd: z.number().positive().optional(),
    })
    .prefault({}),
  sandbox: z
    .object({
      network: z.enum(["none", "restricted", "full"]).default("restricted"),
      filesystem: z.enum(["none", "workspace", "full"]).default("workspace"),
    })
    .prefault({}),
});

export const ManifestSchema = z
  .object({
    specVersion: z.literal(SPEC_VERSION),
    meta: z.object({
      name: z.string().min(1),
      slug: SlugSchema,
      description: z.string().optional(),
      /** Template id this manifest was instantiated from, if any. */
      template: z.string().optional(),
      tags: z.array(z.string()).default([]),
    }),
    models: z.object({
      default: ModelRefSchema,
      /** Named roles ("reasoning", "fallback", "critic", ...) → models. Routing is data. */
      roles: z.record(z.string(), ModelRefSchema).prefault({}),
    }),
    agents: z.array(AgentDefSchema).min(1),
    /** Name of the agent that receives user messages and orchestrates. */
    entryAgent: z.string().min(1),
    tools: z.array(ToolGrantSchema).default([]),
    memory: z
      .object({
        longTerm: z.boolean().default(false),
        knowledge: z.boolean().default(false),
      })
      .prefault({}),
    permissions: PermissionPolicySchema.prefault({}),
    triggers: z
      .object({
        schedules: z.array(ScheduleTriggerSchema).default([]),
        events: z.array(EventTriggerSchema).default([]),
      })
      .prefault({}),
    channels: z.array(ChannelBindingSchema).default([]),
    deployment: DeploymentSchema.prefault({}),
    runtime: RuntimeConfigSchema.prefault({}),
    dashboard: DashboardSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const agentNames = new Set(manifest.agents.map((a) => a.name));
    if (agentNames.size !== manifest.agents.length) {
      ctx.addIssue({ code: "custom", message: "duplicate agent names", path: ["agents"] });
    }
    const toolNames = new Set(manifest.tools.map((t) => t.name));
    if (toolNames.size !== manifest.tools.length) {
      ctx.addIssue({ code: "custom", message: "duplicate tool names", path: ["tools"] });
    }
    if (!agentNames.has(manifest.entryAgent)) {
      ctx.addIssue({
        code: "custom",
        message: `entryAgent "${manifest.entryAgent}" is not a defined agent`,
        path: ["entryAgent"],
      });
    }
    manifest.agents.forEach((agent, i) => {
      if (agent.model !== undefined && !(agent.model in manifest.models.roles)) {
        ctx.addIssue({
          code: "custom",
          message: `agent "${agent.name}" references unknown model role "${agent.model}"`,
          path: ["agents", i, "model"],
        });
      }
      for (const tool of agent.tools) {
        if (!toolNames.has(tool)) {
          ctx.addIssue({
            code: "custom",
            message: `agent "${agent.name}" references unknown tool "${tool}"`,
            path: ["agents", i, "tools"],
          });
        }
      }
      for (const delegate of agent.canDelegateTo) {
        if (!agentNames.has(delegate)) {
          ctx.addIssue({
            code: "custom",
            message: `agent "${agent.name}" cannot delegate to unknown agent "${delegate}"`,
            path: ["agents", i, "canDelegateTo"],
          });
        }
      }
    });
    for (const [kind, triggers] of [
      ["schedules", manifest.triggers.schedules],
      ["events", manifest.triggers.events],
    ] as const) {
      triggers.forEach((trigger, i) => {
        if (trigger.agent !== undefined && !agentNames.has(trigger.agent)) {
          ctx.addIssue({
            code: "custom",
            message: `trigger "${trigger.name}" references unknown agent "${trigger.agent}"`,
            path: ["triggers", kind, i, "agent"],
          });
        }
      });
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Versioned upgrade functions: migrations[n] upgrades a manifest from
 * specVersion n to n+1. Every breaking schema change ships one.
 */
const migrations: Record<number, (manifest: Record<string, unknown>) => Record<string, unknown>> =
  {};

export function migrateManifest(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  let manifest = input as Record<string, unknown>;
  let version = typeof manifest.specVersion === "number" ? manifest.specVersion : SPEC_VERSION;
  while (version < SPEC_VERSION) {
    const migrate = migrations[version];
    if (!migrate) break;
    manifest = { ...migrate(manifest), specVersion: version + 1 };
    version += 1;
  }
  return manifest;
}

/** Parse unknown input into a valid Manifest, migrating old versions first. Throws ZodError. */
export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(migrateManifest(input));
}

/** Non-throwing variant of {@link parseManifest}. */
export function safeParseManifest(input: unknown): z.ZodSafeParseResult<Manifest> {
  return ManifestSchema.safeParse(migrateManifest(input));
}
