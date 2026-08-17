import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let owner: TestUser;
let api: ReturnType<typeof as>;

beforeEach(async () => {
  ctx = await createTestApp();
  owner = await signUp(ctx.app, "platform-owner@example.com");
  api = as(ctx.app, owner);
});

afterEach(async () => {
  await ctx.close();
});

describe("API tokens", () => {
  it("authenticates with a separately revocable token", async () => {
    const created = await api("/v1/auth/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "CI", expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: { id: string; value: string } };
    expect(token.value).toMatch(/^brg_/);

    const withToken = as(ctx.app, { token: token.value });
    expect((await withToken("/v1/workspaces")).status).toBe(200);
    expect((await api(`/v1/auth/tokens/${token.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await withToken("/v1/workspaces")).status).toBe(401);
  });
});

describe("workspace invitations", () => {
  it("joins an invited user to the existing workspace during signup", async () => {
    const created = await api(`/v1/workspaces/${owner.workspaceId}/invitations`, {
      method: "POST",
      body: JSON.stringify({ email: "invitee@example.com", role: "admin" }),
    });
    const { invitation } = (await created.json()) as { invitation: { token: string } };

    const signup = await ctx.app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "invitee@example.com",
        password: "a-sufficiently-long-password",
        invitationToken: invitation.token,
      }),
    });
    expect(signup.status).toBe(201);
    const body = (await signup.json()) as { workspace: { id: string } };
    expect(body.workspace.id).toBe(owner.workspaceId);
  });

  it("does not reveal invitations to another workspace", async () => {
    const outsider = await signUp(ctx.app, "platform-outsider@example.com");
    const response = await as(ctx.app, outsider)(`/v1/workspaces/${owner.workspaceId}/invitations`);
    expect(response.status).toBe(404);
  });
});

describe("workspace search", () => {
  it("stores a key encrypted, returns only its hint, and keeps it on ordinary edits", async () => {
    const secret = "brave-search-super-secret";
    expect(
      (
        await api(`/v1/workspaces/${owner.workspaceId}/search`, {
          method: "PUT",
          body: JSON.stringify({ provider: "brave", apiKey: secret }),
        })
      ).status,
    ).toBe(200);

    const listed = await api(`/v1/workspaces/${owner.workspaceId}/search`);
    const text = await listed.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toMatchObject({
      search: { provider: "brave", apiKeyHint: "bra…cret" },
    });
    expect(ctx.logs.join("\n")).not.toContain(secret);

    expect(
      (
        await api(`/v1/workspaces/${owner.workspaceId}/search`, {
          method: "PUT",
          body: JSON.stringify({ provider: "brave" }),
        })
      ).status,
    ).toBe(200);
  });
});

describe("durable memory and workspace dashboards", () => {
  it("keeps both resources scoped to their workspace", async () => {
    const createdAgent = await api(`/v1/workspaces/${owner.workspaceId}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "Memory agent", instructions: "Remember useful facts." }),
    });
    const agent = ((await createdAgent.json()) as { agent: { id: string } }).agent;
    const memory = await api(`/v1/workspaces/${owner.workspaceId}/memory`, {
      method: "POST",
      body: JSON.stringify({ agentId: agent.id, kind: "knowledge", content: "Acme uses UTC." }),
    });
    expect(memory.status).toBe(201);

    const dashboard = {
      version: 1,
      name: "Operations",
      pages: [
        {
          id: "overview",
          title: "Overview",
          sections: [{ id: "status", widgets: [{ id: "agents", type: "agentStatus" }] }],
        },
      ],
    };
    expect(
      (
        await api(`/v1/workspaces/${owner.workspaceId}/dashboard`, {
          method: "PUT",
          body: JSON.stringify(dashboard),
        })
      ).status,
    ).toBe(200);

    const outsider = await signUp(ctx.app, "platform-memory-outsider@example.com");
    const outsiderApi = as(ctx.app, outsider);
    expect((await outsiderApi(`/v1/workspaces/${owner.workspaceId}/memory`)).status).toBe(404);
    expect((await outsiderApi(`/v1/workspaces/${owner.workspaceId}/dashboard`)).status).toBe(404);
    expect(
      (
        (await (await api(`/v1/workspaces/${owner.workspaceId}/memory?q=UTC`)).json()) as {
          memories: unknown[];
        }
      ).memories,
    ).toHaveLength(1);
  });
});
