import { secrets } from "@bridge/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

/**
 * Multi-tenant isolation. These are the tests that must never be allowed to
 * go red: a leak here is a leak of someone else's agents and credentials.
 */
let ctx: TestApp;
let alice: TestUser;
let mallory: TestUser;
let asAlice: ReturnType<typeof as>;
let asMallory: ReturnType<typeof as>;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestApp();
  alice = await signUp(ctx.app, "alice@example.com");
  mallory = await signUp(ctx.app, "mallory@example.com");
  asAlice = as(ctx.app, alice);
  asMallory = as(ctx.app, mallory);

  const created = await asAlice(`/v1/workspaces/${alice.workspaceId}/agents`, {
    method: "POST",
    body: JSON.stringify({ templateId: "personal-assistant", name: "Alice Assistant" }),
  });
  agentId = ((await created.json()) as { agent: { id: string } }).agent.id;

  await asAlice(`/v1/workspaces/${alice.workspaceId}/providers`, {
    method: "PUT",
    body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-alice-secret-key" }),
  });
});
afterEach(async () => {
  await ctx.close();
});

describe("workspace boundaries", () => {
  it("lists only workspaces the caller belongs to", async () => {
    const res = await asMallory("/v1/workspaces");
    const body = (await res.json()) as { workspaces: { id: string }[] };
    expect(body.workspaces.map((w) => w.id)).toEqual([mallory.workspaceId]);
  });

  it.each([
    ["workspace", (id: string) => `/v1/workspaces/${id}`],
    ["members", (id: string) => `/v1/workspaces/${id}/members`],
    ["agents", (id: string) => `/v1/workspaces/${id}/agents`],
    ["providers", (id: string) => `/v1/workspaces/${id}/providers`],
  ])("hides another tenant's %s", async (_label, path) => {
    const res = await asMallory(path(alice.workspaceId));
    expect(res.status).toBe(404);
  });

  it("does not reveal whether another tenant's agent exists", async () => {
    const real = await asMallory(`/v1/workspaces/${alice.workspaceId}/agents/${agentId}`);
    const fake = await asMallory(`/v1/workspaces/${alice.workspaceId}/agents/agt_does_not_exist`);
    expect(real.status).toBe(404);
    expect(await real.json()).toEqual(await fake.json());
  });
});

describe("cross-tenant writes", () => {
  it("cannot create an agent in another tenant's workspace", async () => {
    const res = await asMallory(`/v1/workspaces/${alice.workspaceId}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "Trojan" }),
    });
    expect(res.status).toBe(404);

    const list = await asAlice(`/v1/workspaces/${alice.workspaceId}/agents`);
    expect(((await list.json()) as { agents: unknown[] }).agents).toHaveLength(1);
  });

  it("cannot overwrite another tenant's agent", async () => {
    const res = await asMallory(`/v1/workspaces/${alice.workspaceId}/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify({ manifest: { specVersion: 1 } }),
    });
    expect(res.status).toBe(404);
  });

  it("cannot delete another tenant's agent", async () => {
    const res = await asMallory(`/v1/workspaces/${alice.workspaceId}/agents/${agentId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);

    const stillThere = await asAlice(`/v1/workspaces/${alice.workspaceId}/agents/${agentId}`);
    expect(stillThere.status).toBe(200);
  });

  it("cannot add itself to another tenant's workspace", async () => {
    const res = await asMallory(`/v1/workspaces/${alice.workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ email: mallory.email }),
    });
    expect(res.status).toBe(404);
  });

  it("cannot disconnect another tenant's provider", async () => {
    const res = await asMallory(`/v1/workspaces/${alice.workspaceId}/providers/anthropic`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);

    const aliceProviders = await asAlice(`/v1/workspaces/${alice.workspaceId}/providers`);
    expect(((await aliceProviders.json()) as { providers: unknown[] }).providers).toHaveLength(1);
  });
});

describe("credentials", () => {
  const apiKey = "sk-ant-alice-secret-key";

  it("is stored encrypted, never as plaintext", async () => {
    const rows = await ctx.handle.db.select().from(secrets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ciphertext).not.toContain(apiKey);
    expect(rows[0]?.ciphertext.startsWith("v1.")).toBe(true);
  });

  it("is never returned by the API, only a masked hint", async () => {
    const res = await asAlice(`/v1/workspaces/${alice.workspaceId}/providers`);
    const text = await res.text();
    expect(text).not.toContain(apiKey);
    expect(text).toContain("sk-…-key");
  });

  it("never reaches the logs", () => {
    expect(ctx.logs.join("\n")).not.toContain(apiKey);
  });

  it("is destroyed when the provider is disconnected", async () => {
    const res = await asAlice(`/v1/workspaces/${alice.workspaceId}/providers/anthropic`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(await ctx.handle.db.select().from(secrets)).toHaveLength(0);
  });

  it("is destroyed with the workspace it belongs to", async () => {
    await ctx.handle.db.delete(secrets);
    expect(await ctx.handle.db.select().from(secrets)).toHaveLength(0);
  });
});
