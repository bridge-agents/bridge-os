import { z } from "zod";
import { ModelRefSchema, SlugSchema } from "./common.js";
import { DashboardSchema } from "./dashboard.js";
import { isDuration } from "./duration.js";
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
  /** Workspace secret names this agent is explicitly allowed to resolve. */
  secrets: z.array(z.string()).default([]),
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
  /** Config path to workspace secret name, e.g. `headers.authorization`. */
  secretBindings: z.record(z.string(), z.string()).optional(),
});
export type ToolGrant = z.infer<typeof ToolGrantSchema>;

/** How hard a model should think, where the model supports being told. */
export const ReasoningEffortSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * Bounds that turn a repeating trigger into a loop that ends.
 *
 * An automation nobody stops is the failure mode of this whole feature: it
 * runs while you sleep, spends money, and the first you hear of it is the
 * bill. So every repeating trigger can carry its own ending, and the runner
 * enforces these rather than trusting the agent to stop itself.
 */
export const LoopBoundsSchema = z.object({
  /** Stop after this many runs. "Check the deploy 10 times, then give up." */
  maxRuns: z.number().int().positive().max(100_000).optional(),
  /** Stop at this instant, whatever the count. ISO 8601. */
  until: z.string().datetime({ offset: true }).optional(),
  /**
   * Stop after this many consecutive failures. A schedule failing every
   * minute forever is noise, not resilience.
   */
  maxConsecutiveFailures: z.number().int().positive().max(1000).default(5),
});

export const ScheduleTriggerSchema = z
  .object({
    name: SlugSchema,
    /** Human-readable label; `name` remains the stable machine identifier. */
    title: z.string().trim().min(1).max(120).optional(),
    /** Calendar schedules: "0 9 * * 1-5". Mutually exclusive with `every`. */
    cron: z.string().min(1).optional(),
    /** Interval loops: "5m", "2h", "1d". Mutually exclusive with `cron`. */
    every: z.string().min(1).optional(),
    /**
     * IANA zone for a cron time. Left out, the workspace's zone applies —
     * which is what makes "9am" mean 9am where the user is without every
     * manifest having to say so.
     */
    timezone: z.string().optional(),
    /** Agent to run; omitted → entry agent. */
    agent: z.string().optional(),
    /** Natural-language task input for the scheduled run. */
    input: z.string().optional(),
    /**
     * Model for this automation's runs. Left out, the workspace default
     * applies, then the agent's own — which is how a schedule ends up on a
     * model nobody chose.
     */
    model: ModelRefSchema.optional(),
    reasoningEffort: ReasoningEffortSchema.optional(),
    /** Off without deleting it — the ordinary way to stop an automation. */
    enabled: z.boolean().default(true),
    loop: LoopBoundsSchema.prefault({}),
  })
  .superRefine((trigger, ctx) => {
    // One or the other, never both: a trigger with two notions of "when" has
    // no answer to "when does this next run?".
    if (!trigger.cron === !trigger.every) {
      ctx.addIssue({
        code: "custom",
        message: 'a schedule needs exactly one of "cron" or "every"',
        path: ["cron"],
      });
    }
    if (trigger.every && !isDuration(trigger.every)) {
      ctx.addIssue({
        code: "custom",
        message: 'use a duration like "30s", "5m", "2h" or "1d"',
        path: ["every"],
      });
    }
  });

export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;
export type LoopBounds = z.infer<typeof LoopBoundsSchema>;

export const EventTriggerSchema = z.object({
  name: SlugSchema,
  /** Human-readable label; `name` remains the stable machine identifier. */
  title: z.string().trim().min(1).max(120).optional(),
  /** Event type this trigger subscribes to (see events.ts catalog). */
  event: z.string().min(1),
  agent: z.string().optional(),
  /** Task for the run this event starts; the event is appended as context. */
  input: z.string().optional(),
  model: ModelRefSchema.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  enabled: z.boolean().default(true),
  loop: LoopBoundsSchema.prefault({}),
});

export type EventTrigger = z.infer<typeof EventTriggerSchema>;

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
      /**
       * Directories outside the agent's own workspace it may work in — a
       * notes folder, a project. This is how an agent reaches your real
       * files without being handed the machine, and naming them is the
       * point: a list you wrote is auditable in a way "full" is not.
       */
      allowedPaths: z.array(z.string().min(1)).max(32).default([]),
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
        const grant = manifest.tools.find((candidate) => candidate.name === tool);
        for (const secretName of Object.values(grant?.secretBindings ?? {})) {
          if (!agent.secrets.includes(secretName)) {
            ctx.addIssue({
              code: "custom",
              message: `agent "${agent.name}" must explicitly allow secret "${secretName}"`,
              path: ["agents", i, "secrets"],
            });
          }
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
