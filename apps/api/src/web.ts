import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "./http.js";

/**
 * Serving the built web client from the API process.
 *
 * In development the Vite dev server hosts the SPA and proxies `/api` here.
 * An installed Bridge has no Vite: the desktop app supervises exactly one
 * process, so the API serves the built assets itself and the whole product
 * is one origin, one port, one thing to start.
 *
 * That the client calls `/api/...` in both worlds is why `buildApp` mounts
 * its routes at `/` and at `/api` — the same bundle works behind the dev
 * proxy and in the packaged app with no build-time switch.
 */
const API_PREFIXES = ["/v1", "/api", "/health"];

export function mountWebApp(app: Hono<AppEnv>, dir: string): void {
  /**
   * Hashed filenames (Vite's `assets/index-a1b2c3.js`) can be cached
   * forever, because a new build has a new name. The app shell never can:
   * it is the file that names those assets, so a cached shell after an
   * update asks for files that no longer exist.
   */
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.ok) return;
    if (c.req.path.startsWith("/assets/")) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      c.header("cache-control", "no-cache");
    }
  });

  app.use("*", serveStatic({ root: dir }));

  /**
   * History fallback: `/agents/agent_123` is a client route, not a file, so
   * anything that is not an API path and not a file on disk gets the shell.
   * API paths are excluded deliberately — a mistyped endpoint must still 404
   * as JSON rather than answering an HTTP client with a page.
   */
  app.get("*", async (c, next) => {
    if (API_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next();

    const html = await readFile(join(dir, "index.html"), "utf8").catch(() => undefined);
    if (html === undefined) return next();
    return c.html(html);
  });
}
