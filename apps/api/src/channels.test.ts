import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let path: string;
let agentId: string;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "channels-owner@example.com");
  api = as(ctx.app, user);
  path = `/v1/workspaces/${user.workspaceId}/channels`;
  const created = await api(`/v1/workspaces/${user.workspaceId}/agents`, {
    method: "POST",
    body: JSON.stringify({ templateId: "personal-assistant", name: "Channel assistant" }),
  });
  agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  await ctx.close();
});

describe("channel configuration", () => {
  it("publishes installed and runtime-dependent connectors", async () => {
    const response = await api(path);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      connectors: { type: string; status: string }[];
      bindings: unknown[];
    };
    expect(body.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "telegram", status: "available" }),
        expect.objectContaining({ type: "discord", status: "available" }),
        expect.objectContaining({ type: "slack", status: "available" }),
        expect.objectContaining({ type: "whatsapp", status: "available" }),
        expect.objectContaining({
          type: "imessage",
          status: process.platform === "darwin" ? "available" : "requires-native-helper",
        }),
        expect.objectContaining({ type: "signal", status: "available" }),
        expect.objectContaining({ type: "matrix", status: "available" }),
      ]),
    );
    expect(body.bindings).toEqual([]);
  });

  it("encrypts a token, updates the manifest, and removes both on disconnect", async () => {
    const connected = await api(`${path}/telegram`, {
      method: "PUT",
      body: JSON.stringify({ agentId, credentials: { token: "123456:super-secret-token" } }),
    });
    expect(connected.status).toBe(201);

    const agent = (await (
      await api(`/v1/workspaces/${user.workspaceId}/agents/${agentId}`)
    ).json()) as {
      agent: { manifest: { channels: { type: string; config: { tokenSecret: string } }[] } };
    };
    expect(agent.agent.manifest.channels[0]).toMatchObject({ type: "telegram" });
    expect(JSON.stringify(agent)).not.toContain("super-secret-token");

    const listed = (await (await api(path)).json()) as {
      bindings: { type: string; credentials: Record<string, { hint: string }> }[];
    };
    expect(listed.bindings[0]?.credentials.tokenSecret?.hint).toBe("123…oken");

    expect((await api(`${path}/telegram/${agentId}`, { method: "DELETE" })).status).toBe(204);
    expect(((await (await api(path)).json()) as { bindings: unknown[] }).bindings).toEqual([]);
  });

  it("validates every credential required by an installed adapter", async () => {
    expect(
      (
        await api(`${path}/whatsapp`, {
          method: "PUT",
          body: JSON.stringify({ agentId, credentials: { token: "not-used" } }),
        })
      ).status,
    ).toBe(422);
  });

  it("does not let a workspace member change channel credentials", async () => {
    const member = await signUp(ctx.app, "channels-member@example.com");
    await api(`/v1/workspaces/${user.workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ email: member.email, role: "member" }),
    });
    const response = await as(ctx.app, member)(`${path}/telegram`, {
      method: "PUT",
      body: JSON.stringify({ agentId, credentials: { token: "member-token" } }),
    });
    expect(response.status).toBe(403);
  });
});
