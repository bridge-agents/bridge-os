import { events } from "@bridge/db";
import { personalAssistantTemplate } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let agentsPath: string;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  agentsPath = `/v1/workspaces/${user.workspaceId}/agents`;
});
afterEach(async () => {
  await ctx.close();
});

const create = (body: unknown) => api(agentsPath, { method: "POST", body: JSON.stringify(body) });

describe("templates", () => {
  it("lists the catalog", async () => {
    const res = await ctx.app.request("/v1/templates");
    const body = (await res.json()) as { templates: { id: string }[] };
    expect(body.templates.map((t) => t.id)).toContain("personal-assistant");
  });

  it("returns a full template manifest", async () => {
    const res = await ctx.app.request("/v1/templates/software-team");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { template: { manifest: { agents: unknown[] } } };
    expect(body.template.manifest.agents).toHaveLength(3);
  });

  it("404s an unknown template", async () => {
    expect((await ctx.app.request("/v1/templates/nope")).status).toBe(404);
  });
});

describe("agent creation", () => {
  it("creates from a template", async () => {
    const res = await create({ templateId: "personal-assistant", name: "My Assistant" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      agent: {
        id: string;
        manifest: { meta: { slug: string; template: string }; agents: unknown[] };
      };
    };
    expect(body.agent.id).toMatch(/^agt_/);
    expect(body.agent.manifest.meta.slug).toBe("my-assistant");
    expect(body.agent.manifest.meta.template).toBe("personal-assistant");
    expect(body.agent.manifest.agents).toHaveLength(2);
  });

  it("creates a blank agent from just a name", async () => {
    const res = await create({ name: "Blank Bot", instructions: "Be useful." });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: { manifest: { agents: { instructions: string }[]; entryAgent: string } };
    };
    expect(body.agent.manifest.entryAgent).toBe("main");
    expect(body.agent.manifest.agents[0]?.instructions).toBe("Be useful.");
  });

  it("creates from a supplied manifest", async () => {
    const res = await create({ manifest: personalAssistantTemplate.manifest });
    expect(res.status).toBe(201);
  });

  it("defaults new agents to running on this device", async () => {
    const res = await create({ name: "Local Agent" });
    const body = (await res.json()) as { agent: { manifest: { deployment: { target: string } } } };
    expect(body.agent.manifest.deployment.target).toBe("local");
  });

  it("rejects an invalid manifest with actionable issues", async () => {
    const res = await create({ manifest: { specVersion: 1, meta: { name: "x", slug: "x" } } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.length).toBeGreaterThan(0);
  });

  it("rejects a manifest whose agent references an undeclared tool", async () => {
    const manifest = structuredClone(personalAssistantTemplate.manifest);
    manifest.agents[0]?.tools.push("gmail");
    const res = await create({ manifest });
    expect(res.status).toBe(422);
  });

  it("requires at least one of templateId, manifest or name", async () => {
    expect((await create({})).status).toBe(422);
  });

  it("rejects a duplicate slug in the same workspace", async () => {
    await create({ name: "Twin" });
    expect((await create({ name: "Twin" })).status).toBe(409);
  });

  it("records an agent.created event in the audit log", async () => {
    const created = (await (await create({ name: "Audited" })).json()) as {
      agent: { id: string };
    };

    const rows = await ctx.handle.db
      .select()
      .from(events)
      .where(eq(events.workspaceId, user.workspaceId));

    expect(rows.map((row) => row.type)).toContain("agent.created");
    expect(rows[0]?.agentId).toBe(created.agent.id);
  });
});

describe("agent lifecycle", () => {
  it("lists, reads, updates and deletes", async () => {
    const created = (await (await create({ templateId: "research-agent" })).json()) as {
      agent: { id: string; manifest: Record<string, unknown> };
    };
    const agentId = created.agent.id;

    const list = (await (await api(agentsPath)).json()) as { agents: { id: string }[] };
    expect(list.agents.map((a) => a.id)).toEqual([agentId]);

    const read = await api(`${agentsPath}/${agentId}`);
    expect(read.status).toBe(200);

    const manifest = {
      ...(created.agent.manifest as Record<string, unknown>),
      meta: { name: "Renamed Research", slug: "renamed-research" },
    };
    const updated = await api(`${agentsPath}/${agentId}`, {
      method: "PUT",
      body: JSON.stringify({ manifest }),
    });
    expect(updated.status).toBe(200);

    const reread = (await (await api(`${agentsPath}/${agentId}`)).json()) as {
      agent: { name: string; manifest: { meta: { name: string } } };
    };
    expect(reread.agent.manifest.meta.name).toBe("Renamed Research");
    expect(reread.agent.name).toBe("Renamed Research");

    expect((await api(`${agentsPath}/${agentId}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`${agentsPath}/${agentId}`)).status).toBe(404);
  });

  it("rejects an update that would make the manifest invalid", async () => {
    const created = (await (await create({ name: "Strict" })).json()) as { agent: { id: string } };
    const res = await api(`${agentsPath}/${created.agent.id}`, {
      method: "PUT",
      body: JSON.stringify({ manifest: { specVersion: 1, meta: { name: "x", slug: "x" } } }),
    });
    expect(res.status).toBe(422);
  });

  it("moves an agent to another deployment target without recreating it", async () => {
    const created = (await (await create({ name: "Portable" })).json()) as {
      agent: { id: string; manifest: Record<string, unknown> };
    };
    const res = await api(`${agentsPath}/${created.agent.id}`, {
      method: "PUT",
      body: JSON.stringify({
        manifest: { ...created.agent.manifest, deployment: { target: "cloud", background: true } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { manifest: { deployment: { target: string } } } };
    expect(body.agent.manifest.deployment.target).toBe("cloud");
  });

  it("requires authentication", async () => {
    expect((await ctx.app.request(agentsPath)).status).toBe(401);
  });
});
