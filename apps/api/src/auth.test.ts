import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { as, createTestApp, signUp, type TestApp } from "./testing.js";

let ctx: TestApp;

beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await ctx.close();
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("signup", () => {
  it("creates an account, a starter workspace and a session", async () => {
    const res = await ctx.app.request(
      "/v1/auth/signup",
      json({ email: "Ada@example.com", password: "correct horse battery staple" }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      user: { id: string; email: string };
      workspace: { id: string };
      token: string;
    };
    expect(body.user.email).toBe("ada@example.com"); // normalized
    expect(body.workspace.id).toMatch(/^ws_/);
    expect(body.token).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain("bridge_session=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("rejects duplicate emails", async () => {
    await signUp(ctx.app, "dup@example.com");
    const res = await ctx.app.request(
      "/v1/auth/signup",
      json({ email: "dup@example.com", password: "another-long-password" }),
    );
    expect(res.status).toBe(409);
  });

  it("rejects weak or malformed credentials with field-level issues", async () => {
    const res = await ctx.app.request(
      "/v1/auth/signup",
      json({ email: "nope", password: "short" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: { path: string }[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details.map((d) => d.path).sort()).toEqual(["email", "password"]);
  });

  it("never writes the password or token to the logs", async () => {
    const password = "a-very-recognisable-password";
    await ctx.app.request("/v1/auth/signup", json({ email: "log@example.com", password }));
    expect(ctx.logs.join("\n")).not.toContain(password);
  });
});

describe("login", () => {
  it("accepts correct credentials", async () => {
    await signUp(ctx.app, "user@example.com");
    const res = await ctx.app.request(
      "/v1/auth/login",
      json({ email: "user@example.com", password: "a-sufficiently-long-password" }),
    );
    expect(res.status).toBe(200);
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await signUp(ctx.app, "user@example.com");
    const wrongPassword = await ctx.app.request(
      "/v1/auth/login",
      json({ email: "user@example.com", password: "not-the-right-password" }),
    );
    const unknownUser = await ctx.app.request(
      "/v1/auth/login",
      json({ email: "ghost@example.com", password: "not-the-right-password" }),
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownUser.json());
  });

  it("rate-limits repeated attempts against one account", async () => {
    await signUp(ctx.app, "target@example.com");
    const attempt = () =>
      ctx.app.request(
        "/v1/auth/login",
        json({ email: "target@example.com", password: "wrong-guess-here" }),
      );

    let limited = false;
    for (let i = 0; i < 15; i++) {
      if ((await attempt()).status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("sessions", () => {
  it("identifies the caller from a bearer token", async () => {
    const user = await signUp(ctx.app, "me@example.com");
    const res = await as(ctx.app, user)("/v1/auth/me");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe("me@example.com");
  });

  it("rejects missing and invalid tokens", async () => {
    expect((await ctx.app.request("/v1/auth/me")).status).toBe(401);
    const res = await ctx.app.request("/v1/auth/me", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("logout invalidates the session immediately", async () => {
    const user = await signUp(ctx.app, "bye@example.com");
    const authed = as(ctx.app, user);

    expect((await authed("/v1/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await authed("/v1/auth/me")).status).toBe(401);
  });

  it("accepts the session cookie as well as the bearer token", async () => {
    const signup = await ctx.app.request(
      "/v1/auth/signup",
      json({ email: "cookie@example.com", password: "a-sufficiently-long-password" }),
    );
    const cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await ctx.app.request("/v1/auth/me", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
