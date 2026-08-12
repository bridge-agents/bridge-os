import { generateSecretKey, parseSecretKey } from "@bridge/core";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp, type TestUser } from "./testing.js";

let ctx: TestApp;
let user: TestUser;
let api: ReturnType<typeof as>;
let path: string;

beforeEach(async () => {
  ctx = await createTestApp();
  user = await signUp(ctx.app, "owner@example.com");
  api = as(ctx.app, user);
  path = `/v1/workspaces/${user.workspaceId}/providers`;
});
afterEach(async () => {
  await ctx.close();
});

const connect = (body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });

describe("provider configuration", () => {
  it("connects a hosted provider with an API key", async () => {
    const res = await connect({ provider: "anthropic", apiKey: "sk-ant-example-key-value" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { provider: { provider: string; keyHint: string } };
    expect(body.provider.provider).toBe("anthropic");
    expect(body.provider.keyHint).toBe("sk-…alue");
  });

  it("connects a local endpoint that needs a URL instead of a key", async () => {
    const res = await connect({ provider: "ollama", baseUrl: "http://localhost:11434" });
    expect(res.status).toBe(201);

    const list = (await (await api(path)).json()) as {
      providers: { provider: string; baseUrl: string; keyHint: string | null }[];
    };
    expect(list.providers[0]?.baseUrl).toBe("http://localhost:11434");
    expect(list.providers[0]?.keyHint).toBeNull();
  });

  it("requires a key for hosted providers and a URL for local ones", async () => {
    expect((await connect({ provider: "anthropic" })).status).toBe(422);
    expect((await connect({ provider: "ollama" })).status).toBe(422);
  });

  it("rejects unknown providers", async () => {
    expect((await connect({ provider: "skynet", apiKey: "x" })).status).toBe(422);
  });

  it("replaces the credential when reconnecting the same provider", async () => {
    await connect({ provider: "openai", apiKey: "sk-first-key-value" });
    await connect({ provider: "openai", apiKey: "sk-second-key-value" });

    const list = (await (await api(path)).json()) as { providers: { keyHint: string }[] };
    expect(list.providers).toHaveLength(1);
    expect(list.providers[0]?.keyHint).toBe("sk-…alue");
  });

  it("lets several providers coexist so agents can mix models", async () => {
    await connect({ provider: "anthropic", apiKey: "sk-ant-key-value" });
    await connect({ provider: "openai", apiKey: "sk-openai-key-value" });

    const list = (await (await api(path)).json()) as { providers: { provider: string }[] };
    expect(list.providers.map((p) => p.provider).sort()).toEqual(["anthropic", "openai"]);
  });

  it("404s when disconnecting a provider that was never connected", async () => {
    expect((await api(`${path}/google`, { method: "DELETE" })).status).toBe(404);
  });

  it("does not let a plain member change provider credentials", async () => {
    const member = await signUp(ctx.app, "member@example.com");
    await api(`/v1/workspaces/${user.workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ email: member.email, role: "member" }),
    });

    const res = await as(ctx.app, member)(path, {
      method: "PUT",
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-member-key" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("EncryptedDbSecretStore", () => {
  it("reveals a secret only within its own workspace", async () => {
    const store = new EncryptedDbSecretStore(ctx.handle.db, parseSecretKey(generateSecretKey()));
    const ref = await store.put(user.workspaceId, "provider:test", "the-value");

    expect(await store.reveal(user.workspaceId, ref.id)).toBe("the-value");
    expect(await store.reveal("ws_someone_else", ref.id)).toBeUndefined();
  });

  it("lists references without values", async () => {
    const store = new EncryptedDbSecretStore(ctx.handle.db, parseSecretKey(generateSecretKey()));
    await store.put(user.workspaceId, "provider:test", "super-secret-value");

    const listed = await store.list(user.workspaceId);
    expect(JSON.stringify(listed)).not.toContain("super-secret-value");
    expect(listed[0]?.hint).toBe("sup…alue");
  });
});
