import { BridgeError } from "@bridge/core";
import { agents, automations, type Db, workspaces } from "@bridge/db";
import {
  AutomationRunner,
  createConversation,
  describeSchedule,
  enqueueRun,
  isValidTimezone,
  nextFireTime,
} from "@bridge/runtime";
import { type Manifest, parseManifest, type ScheduleTrigger } from "@bridge/spec";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * Automations: the live state of an agent's triggers.
 *
 * A row here is *derived* from the agent's manifest, so editing or deleting
 * one edits the manifest and lets the runner re-project it — rather than
 * changing the row and letting the two drift until the next sync silently
 * reverts you. One spec, one place (invariant 1); this endpoint is a
 * convenient way to reach into it, not a second definition of a schedule.
 *
 * What lives only here is the state a portable manifest cannot hold: when it
 * last ran, when it runs next, and whether someone paused it on this
 * machine.
 */
export function automationRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  const load = async (workspaceId: string, automationId: string) => {
    const [row] = await deps.db
      .select()
      .from(automations)
      .where(and(eq(automations.id, automationId), eq(automations.workspaceId, workspaceId)));
    if (!row) throw new BridgeError("not_found", "automation not found");
    return row;
  };

  /** What "9am" means here, when a schedule does not say. */
  const workspaceZone = async (workspaceId: string): Promise<string> => {
    const [row] = await deps.db
      .select({ timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return row?.timezone ?? "UTC";
  };

  app.get("/", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.query("agent");
    const zone = await workspaceZone(workspaceId);

    const rows = await deps.db
      .select({
        id: automations.id,
        agentId: automations.agentId,
        agentName: agents.name,
        name: automations.name,
        kind: automations.kind,
        spec: automations.spec,
        status: automations.status,
        statusReason: automations.statusReason,
        nextRunAt: automations.nextRunAt,
        lastRunAt: automations.lastRunAt,
        lastRunId: automations.lastRunId,
        runsCount: automations.runsCount,
        consecutiveFailures: automations.consecutiveFailures,
      })
      .from(automations)
      .leftJoin(agents, eq(agents.id, automations.agentId))
      .where(
        and(
          eq(automations.workspaceId, workspaceId),
          ...(agentId ? [eq(automations.agentId, agentId)] : []),
        ),
      )
      .orderBy(desc(automations.nextRunAt))
      .limit(200);

    return c.json({
      automations: rows.map((row) => ({
        ...row,
        title: (row.spec as { title?: string }).title ?? row.name,
        // The schedule in words, so a client never has to parse cron itself.
        schedule:
          row.kind === "event"
            ? `on ${(row.spec as { event: string }).event}`
            : describeSchedule(row.spec as ScheduleTrigger, zone),
      })),
    });
  });

  /**
   * Pause and resume, which is what people actually reach for. Deliberately
   * separate from the manifest's `enabled` flag: this is "not right now, on
   * this machine", not a change to the agent's definition.
   */
  app.post("/:automationId/pause", requireRole("owner", "admin"), async (c) => {
    const row = await load(c.get("workspaceId"), c.req.param("automationId"));
    await deps.db
      .update(automations)
      .set({ status: "paused", statusReason: "paused by you", updatedAt: new Date() })
      .where(eq(automations.id, row.id));
    return c.json({ automation: { id: row.id, status: "paused" } });
  });

  app.post("/:automationId/resume", requireRole("owner", "admin"), async (c) => {
    const row = await load(c.get("workspaceId"), c.req.param("automationId"));
    const now = new Date();

    /**
     * Resuming clears the failure count and recomputes the next firing. A
     * schedule that stopped four hours ago must not fire immediately for
     * every slot it missed — it rejoins the rhythm from now.
     *
     * A loop that *finished* starts its count over, because "resume" on
     * something already done can only mean "do it again". Merely paused
     * keeps its count: stopping a 3-run loop after 2 and restarting it
     * should give you the third, not three more.
     */
    const restart = row.status === "completed";

    await deps.db
      .update(automations)
      .set({
        status: "active",
        statusReason: null,
        consecutiveFailures: 0,
        lastRunId: null,
        ...(restart ? { runsCount: 0 } : {}),
        nextRunAt:
          row.kind === "event"
            ? null
            : nextFireTime(
                row.spec as ScheduleTrigger,
                now,
                await workspaceZone(c.get("workspaceId")),
              ),
        updatedAt: now,
      })
      .where(eq(automations.id, row.id));

    return c.json({ automation: { id: row.id, status: "active" } });
  });

  /**
   * Run it now, without waiting and without disturbing the schedule.
   * "Did I set this up right?" is the first question anyone has, and making
   * them wait until 9am to find out is a bad answer.
   */
  app.post("/:automationId/run", async (c) => {
    const workspaceId = c.get("workspaceId");
    const row = await load(workspaceId, c.req.param("automationId"));

    const [agent] = await deps.db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, row.agentId));
    if (!agent) throw new BridgeError("not_found", "agent not found");
    if (agent.status !== "deployed") {
      throw new BridgeError("conflict", "deploy the agent before running its automations");
    }

    const spec = row.spec as ScheduleTrigger;
    // Same model the schedule itself would use, or the workspace default —
    // otherwise "run now" tests something different from what fires at 9am.
    const [workspace] = await deps.db
      .select({
        defaultModel: workspaces.defaultModel,
        defaultReasoning: workspaces.defaultReasoning,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    const runId = await startAutomationRun(deps.db, {
      workspaceId,
      agentId: row.agentId,
      name: spec.title ?? row.name,
      text: spec.input ?? `Manual run of "${row.name}"`,
      model: spec.model ?? workspace?.defaultModel ?? undefined,
      reasoningEffort: spec.reasoningEffort ?? workspace?.defaultReasoning ?? undefined,
    });

    return c.json({ run: { id: runId } }, 201);
  });

  /**
   * Edit the schedule.
   *
   * This writes the agent's manifest, not the row: the manifest is the
   * definition, and a row edited on its own would be overwritten the next
   * time the runner reconciles. Validation is the ordinary manifest
   * validation, so an edit here cannot produce an agent that would be
   * rejected anywhere else.
   */
  app.patch("/:automationId", requireRole("owner", "admin"), async (c) => {
    const workspaceId = c.get("workspaceId");
    const row = await load(workspaceId, c.req.param("automationId"));
    const body = await parseBody(c, EditAutomationSchema);

    const { agent, manifest } = await loadAgentManifest(deps, workspaceId, row.agentId);
    const list = row.kind === "event" ? manifest.triggers.events : manifest.triggers.schedules;
    const index = list.findIndex((trigger) => trigger.name === row.name);
    if (index < 0) throw new BridgeError("not_found", "this trigger is no longer in the manifest");

    // Only the keys actually sent are changed; the rest of the trigger — and
    // the rest of the manifest — is left exactly as the author wrote it.
    const current = list[index] as Record<string, unknown>;
    const updated: Record<string, unknown> = {
      ...current,
      ...(body.title !== undefined ? { title: body.title || undefined } : {}),
      ...(body.input !== undefined ? { input: body.input || undefined } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.model !== undefined ? { model: body.model ?? undefined } : {}),
      ...(body.reasoningEffort !== undefined
        ? { reasoningEffort: body.reasoningEffort ?? undefined }
        : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone || undefined } : {}),
      ...(body.loop !== undefined
        ? { loop: { ...(current.loop as object), ...pruneUndefined(body.loop) } }
        : {}),
    };
    // cron and every are mutually exclusive, so setting one clears the other
    // rather than producing a trigger the schema will reject.
    if (body.cron !== undefined) {
      updated.cron = body.cron || undefined;
      if (body.cron) updated.every = undefined;
    }
    if (body.every !== undefined) {
      updated.every = body.every || undefined;
      if (body.every) updated.cron = undefined;
    }
    list[index] = updated as (typeof list)[number];

    const saved = await saveManifest(deps, agent.id, manifest);
    // Re-project immediately so the answer to "when does it next run?" is
    // right straight away rather than after the next reconcile.
    await new AutomationRunner({ db: deps.db, logger: deps.logger }).sync();

    return c.json({ agent: { id: agent.id, specVersion: saved.specVersion } });
  });

  /** Remove the trigger from the manifest; the row goes with it. */
  app.delete("/:automationId", requireRole("owner", "admin"), async (c) => {
    const workspaceId = c.get("workspaceId");
    const row = await load(workspaceId, c.req.param("automationId"));

    const { agent, manifest } = await loadAgentManifest(deps, workspaceId, row.agentId);
    if (row.kind === "event") {
      manifest.triggers.events = manifest.triggers.events.filter((t) => t.name !== row.name);
    } else {
      manifest.triggers.schedules = manifest.triggers.schedules.filter((t) => t.name !== row.name);
    }

    await saveManifest(deps, agent.id, manifest);
    await deps.db.delete(automations).where(eq(automations.id, row.id));
    return c.body(null, 204);
  });

  return app;
}

/** Fields an automation may change, all of them optional. */
const EditAutomationSchema = z.object({
  title: z.string().trim().min(1).max(120).nullable().optional(),
  cron: z.string().trim().max(120).nullable().optional(),
  every: z.string().trim().max(16).nullable().optional(),
  timezone: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .refine((value) => !value || isValidTimezone(value), {
      message: "not a timezone this machine knows (use an IANA name like Europe/London)",
    }),
  input: z.string().trim().max(10_000).nullable().optional(),
  /** null clears it, which means the workspace default applies again. */
  model: z
    .object({ provider: z.string().min(1), model: z.string().min(1) })
    .nullable()
    .optional(),
  reasoningEffort: z
    .enum(["none", "low", "medium", "high", "xhigh", "max", "ultra"])
    .nullable()
    .optional(),
  enabled: z.boolean().optional(),
  loop: z
    .object({
      maxRuns: z.number().int().positive().max(100_000).nullable().optional(),
      until: z.string().datetime({ offset: true }).nullable().optional(),
      maxConsecutiveFailures: z.number().int().positive().max(1000).optional(),
    })
    .optional(),
});

/** null means "clear it", which in a manifest is the key being absent. */
function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry === null ? undefined : entry]),
  );
}

async function loadAgentManifest(deps: AppDeps, workspaceId: string, agentId: string) {
  const [agent] = await deps.db
    .select({ id: agents.id, manifest: agents.manifest })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
  if (!agent) throw new BridgeError("not_found", "agent not found");
  return { agent, manifest: parseManifest(agent.manifest) };
}

/** Validate and store, the same path a hand-written manifest edit takes. */
async function saveManifest(deps: AppDeps, agentId: string, manifest: Manifest) {
  const validated = parseManifest(manifest);
  await deps.db
    .update(agents)
    .set({ manifest: validated, specVersion: validated.specVersion, updatedAt: new Date() })
    .where(eq(agents.id, agentId));
  return validated;
}

/**
 * A one-off run of an automation's task.
 *
 * Marked `manual`, not `schedule`: a person asked for it, so it should count
 * as their work — and, more practically, an automated run is barred from
 * triggering event automations, which would make "test my automation"
 * mysteriously not fire the thing it was testing.
 */
async function startAutomationRun(
  db: Db,
  input: {
    workspaceId: string;
    agentId: string;
    name: string;
    text: string;
    model?: { provider: string; model: string };
    reasoningEffort?: string;
  },
): Promise<string> {
  const conversationId = await createConversation(db, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    title: `${input.name} (manual)`,
  });
  return enqueueRun(db, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    conversationId,
    text: input.text,
    trigger: "manual",
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort
      ? { reasoningEffort: input.reasoningEffort as "none" | "low" | "medium" | "high" }
      : {}),
  });
}
