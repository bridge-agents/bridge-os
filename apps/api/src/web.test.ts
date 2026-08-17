import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, parseSecretKey } from "@bridge/core";
import { createDb, type DbHandle } from "@bridge/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

/**
 * Serving the built client from the API is what makes an installed Bridge
 * one process instead of two. These cover the three ways that goes wrong:
 * a client route 404ing, an API route answering with a page, and the app
 * shell being cached so an update never arrives.
 */
let handle: DbHandle;
let webDir: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();

  webDir = mkdtempSync(join(tmpdir(), "bridge-web-"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Bridge</title><div id=root>");
  mkdirSync(join(webDir, "assets"));
  writeFileSync(join(webDir, "assets", "index-abc123.js"), "console.log('bridge')");

  app = buildApp({
    db: handle.db,
    logger: pino({ level: "silent" }),
    secretKey: parseSecretKey(generateSecretKey()),
    webDir,
  });
});

afterAll(async () => {
  await handle.close();
  rmSync(webDir, { recursive: true, force: true });
});

const get = (path: string) => app.request(path);

describe("the API serving the web client", () => {
  it("serves the app shell at the root", async () => {
    const res = await get("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>Bridge</title>");
  });

  it("serves a client route that is not a file", async () => {
    // Deep links are how notifications and the tray menu open a page, so a
    // 404 here breaks the desktop app rather than just the browser.
    const res = await get("/agents/agent_123");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div id=root>");
  });

  it("serves built assets as files", async () => {
    const res = await get("/assets/index-abc123.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bridge");
  });

  it("lets hashed assets cache but never the shell", async () => {
    // The filename changes on every build, so the asset is safe to keep
    // forever — the shell is not, or an update never reaches an open window.
    expect((await get("/assets/index-abc123.js")).headers.get("cache-control")).toContain(
      "immutable",
    );
    expect((await get("/")).headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a mistyped API path with JSON, not a page", async () => {
    const res = await get("/v1/nope");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers the same routes under /api, which is what the client calls", async () => {
    // One bundle has to work behind the Vite dev proxy and in the packaged
    // app; mounting twice is what avoids a build-time switch.
    const direct = await (await get("/v1/meta")).json();
    const prefixed = await (await get("/api/v1/meta")).json();

    expect(prefixed).toEqual(direct);
    expect((await get("/api/health")).status).toBe(200);
  });

  it("keeps API errors as JSON under the /api prefix too", async () => {
    const res = await get("/api/v1/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("an API with no built client", () => {
  it("404s a client route instead of pretending to serve one", async () => {
    const bare = buildApp({
      db: handle.db,
      logger: pino({ level: "silent" }),
      secretKey: parseSecretKey(generateSecretKey()),
    });

    const res = await bare.request("/agents/agent_123");
    expect(res.status).toBe(404);
  });
});
