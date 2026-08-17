import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let owner: TestUser;

beforeEach(async () => {
  ctx = await createTestApp();
  owner = await signUp(ctx.app, "workspace-owner@example.com");
});

afterEach(async () => {
  await ctx.close();
});

describe("workspace settings", () => {
  it("persists editable workspace details", async () => {
    const api = as(ctx.app, owner);
    const response = await api(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Client Operations",
        description: "Production agents for client delivery.",
      }),
    });
    expect(response.status).toBe(200);

    const list = (await (await api("/v1/workspaces")).json()) as {
      workspaces: { name: string; description: string | null }[];
    };
    expect(list.workspaces[0]).toMatchObject({
      name: "Client Operations",
      description: "Production agents for client delivery.",
    });
  });

  it("saves a timezone, and hands it back everywhere the workspace is read", async () => {
    const api = as(ctx.app, owner);
    const response = await api(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Ops", timezone: "Europe/Lisbon" }),
    });
    expect(response.status).toBe(200);

    // The list is what the client's session reads, so a zone missing from it
    // is a setting that appears not to have saved.
    const list = (await (await api("/v1/workspaces")).json()) as {
      workspaces: { timezone: string | null }[];
    };
    expect(list.workspaces[0]?.timezone).toBe("Europe/Lisbon");

    const one = (await (await api(`/v1/workspaces/${owner.workspaceId}`)).json()) as {
      workspace: { timezone: string | null };
    };
    expect(one.workspace.timezone).toBe("Europe/Lisbon");
  });

  it("refuses a timezone this machine does not know", async () => {
    // A typo here is a schedule that fires at the wrong hour forever.
    const response = await as(ctx.app, owner)(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Ops", timezone: "Middle/Earth" }),
    });
    expect(response.status).toBe(422);
  });

  it("clears the timezone back to the default", async () => {
    const api = as(ctx.app, owner);
    await api(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Ops", timezone: "Europe/Lisbon" }),
    });
    await api(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Ops", timezone: null }),
    });

    const one = (await (await api(`/v1/workspaces/${owner.workspaceId}`)).json()) as {
      workspace: { timezone: string | null };
    };
    expect(one.workspace.timezone).toBeNull();
  });

  it("does not let a plain member edit workspace details", async () => {
    const api = as(ctx.app, owner);
    const member = await signUp(ctx.app, "workspace-member@example.com");
    await api(`/v1/workspaces/${owner.workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ email: member.email, role: "member" }),
    });

    const response = await as(ctx.app, member)(`/v1/workspaces/${owner.workspaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Unauthorized rename" }),
    });
    expect(response.status).toBe(403);
  });
});
