import { BridgeError, newAgentId } from "@bridge/core";
import { agents, appendEvent } from "@bridge/db";
import {
  blankManifest,
  dashboardTemplates,
  getTemplate,
  instantiateTemplate,
  SPEC_VERSION,
  safeParseManifest,
  templates,
} from "@bridge/spec";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/** Every creation path converges here: one validated manifest, or an error. */
function validate(input: unknown) {
  const result = safeParseManifest(input);
  if (!result.success) {
    throw new BridgeError(
      "validation_failed",
      "invalid agent manifest",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

const CreateAgentSchema = z
  .object({
    templateId: z.string().optional(),
    manifest: z.unknown().optional(),
    name: z.string().min(1).max(120).optional(),
    instructions: z.string().max(20_000).optional(),
  })
  .refine((body) => body.templateId || body.manifest || body.name, {
    message: "provide one of: templateId, manifest, or name",
  });

export function agentRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const rows = await deps.db
      .select({
        id: agents.id,
        name: agents.name,
        slug: agents.slug,
        status: agents.status,
        specVersion: agents.specVersion,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(eq(agents.workspaceId, c.get("workspaceId")))
      .orderBy(desc(agents.updatedAt));
    return c.json({ agents: rows });
  });

  app.post("/", async (c) => {
    const body = await parseBody(c, CreateAgentSchema);
    const workspaceId = c.get("workspaceId");

    let manifest: ReturnType<typeof validate>;
    if (body.templateId) {
      const template = getTemplate(body.templateId);
      if (!template) throw new BridgeError("not_found", `unknown template "${body.templateId}"`);
      manifest = validate(instantiateTemplate(template, { name: body.name }));
    } else if (body.manifest) {
      manifest = validate(body.manifest);
    } else {
      manifest = validate(
        blankManifest({ name: body.name ?? "New Agent", instructions: body.instructions }),
      );
    }

    const [existing] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.slug, manifest.meta.slug)));
    if (existing) {
      throw new BridgeError(
        "conflict",
        `an agent with slug "${manifest.meta.slug}" already exists`,
      );
    }

    const agentId = newAgentId();
    await deps.db.insert(agents).values({
      id: agentId,
      workspaceId,
      name: manifest.meta.name,
      slug: manifest.meta.slug,
      specVersion: SPEC_VERSION,
      manifest,
    });
    await appendEvent(deps.db, "agent.created", {
      workspaceId,
      agentId,
      data: { template: manifest.meta.template ?? null, target: manifest.deployment.target },
    });

    return c.json({ agent: { id: agentId, manifest } }, 201);
  });

  app.get("/:agentId", async (c) => {
    const [row] = await deps.db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workspaceId, c.get("workspaceId")), eq(agents.id, c.req.param("agentId"))),
      );
    if (!row) throw new BridgeError("not_found", "agent not found");
    // Re-validated on read: storage never becomes a second schema authority.
    return c.json({ agent: { ...row, manifest: validate(row.manifest) } });
  });

  /** Full-manifest replace; partial edits are computed client-side or by the Architect. */
  app.put("/:agentId", async (c) => {
    const body = await parseBody(c, z.object({ manifest: z.unknown() }));
    const manifest = validate(body.manifest);
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");

    const updated = await deps.db
      .update(agents)
      .set({
        name: manifest.meta.name,
        slug: manifest.meta.slug,
        specVersion: SPEC_VERSION,
        manifest,
        updatedAt: new Date(),
      })
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
      .returning({ id: agents.id });
    if (updated.length === 0) throw new BridgeError("not_found", "agent not found");

    await appendEvent(deps.db, "agent.updated", { workspaceId, agentId });
    return c.json({ agent: { id: agentId, manifest } });
  });

  app.delete("/:agentId", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.param("agentId");
    const deleted = await deps.db
      .delete(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
      .returning({ id: agents.id });
    if (deleted.length === 0) throw new BridgeError("not_found", "agent not found");

    await appendEvent(deps.db, "agent.deleted", { workspaceId, agentId });
    return c.body(null, 204);
  });

  return app;
}

/** Public catalog; no workspace scope needed since templates are static data. */
export function templateRoutes() {
  const app = new Hono<AppEnv>();

  /**
   * Dashboard templates. Served rather than imported by the client so the
   * browser never needs the schema library, matching how agent templates
   * already work.
   */
  app.get("/dashboards", (c) =>
    c.json({
      templates: dashboardTemplates.map(({ id, name, description, dashboard }) => ({
        id,
        name,
        description,
        pages: dashboard.pages.length,
        widgets: dashboard.pages
          .flatMap((page) => page.sections)
          .reduce((total, section) => total + section.widgets.length, 0),
        dashboard,
      })),
    }),
  );

  app.get("/", (c) =>
    c.json({
      templates: templates.map(({ id, name, description, category, manifest }) => ({
        id,
        name,
        description,
        category,
        agents: manifest.agents.length,
        tools: manifest.tools.map((tool) => tool.name),
      })),
    }),
  );

  app.get("/:templateId", (c) => {
    const template = getTemplate(c.req.param("templateId"));
    if (!template) throw new BridgeError("not_found", "template not found");
    return c.json({ template });
  });

  return app;
}
