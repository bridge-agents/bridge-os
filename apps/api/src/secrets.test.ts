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
  path = `/v1/workspaces/${user.workspaceId}/secrets`;
});
afterEach(async () => {
  await ctx.close();
});

const put = (body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });

describe("workspace secrets", () => {
  it("stores a named secret and returns only a masked hint", async () => {
    const res = await put({ name: "telegram_bot_token", value: "123456:AAExampleBotToken" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { secret: { name: string; hint: string } };
    expect(body.secret.name).toBe("telegram_bot_token");
    expect(body.secret.hint).not.toContain("AAExampleBotToken");
    expect(JSON.stringify(body)).not.toContain("AAExampleBotToken");
  });

  it("never returns the value when listing", async () => {
    await put({ name: "telegram_bot_token", value: "123456:AAExampleBotToken" });

    const list = await (await api(path)).text();
    expect(list).toContain("telegram_bot_token");
    expect(list).not.toContain("AAExampleBotToken");
  });

  it("keeps the plaintext out of the logs", async () => {
    await put({ name: "telegram_bot_token", value: "123456:AAExampleBotToken" });
    expect(ctx.logs.join("\n")).not.toContain("AAExampleBotToken");
  });

  it("replaces a secret reused under the same name", async () => {
    await put({ name: "telegram_bot_token", value: "old-value-aaaaaaaa" });
    await put({ name: "telegram_bot_token", value: "new-value-bbbbbbbb" });

    const body = (await (await api(path)).json()) as { secrets: { hint: string }[] };
    expect(body.secrets).toHaveLength(1);
    expect(body.secrets[0]?.hint).toContain("bbbb");
  });

  it("hides provider credentials, which have their own endpoint", async () => {
    await api(`/v1/workspaces/${user.workspaceId}/providers`, {
      method: "PUT",
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-example-key-value" }),
    });

    const body = (await (await api(path)).json()) as { secrets: unknown[] };
    expect(body.secrets).toHaveLength(0);
    expect((await put({ name: "provider:anthropic", value: "x" })).status).toBe(422);
  });

  it("rejects a name a manifest could not reference", async () => {
    expect((await put({ name: "Telegram Token!", value: "x" })).status).toBe(422);
  });

  it("deletes a secret", async () => {
    const created = (await (await put({ name: "bot", value: "value-1234" })).json()) as {
      secret: { id: string };
    };
    expect((await api(`${path}/${created.secret.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`${path}/${created.secret.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("does not leak secrets across workspaces", async () => {
    const created = (await (await put({ name: "bot", value: "value-1234" })).json()) as {
      secret: { id: string };
    };

    const other = await signUp(ctx.app, "other@example.com");
    const otherApi = as(ctx.app, other);
    const otherPath = `/v1/workspaces/${other.workspaceId}/secrets`;

    const list = (await (await otherApi(otherPath)).json()) as { secrets: unknown[] };
    expect(list.secrets).toHaveLength(0);
    expect((await otherApi(`${otherPath}/${created.secret.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
});
