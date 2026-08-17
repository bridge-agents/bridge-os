import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Build the API into something an installed app can run.
 *
 * Bundling rather than compiling per package: every workspace package
 * exports TypeScript sources directly, so one bundle turns the whole
 * server into a single file with no build step to add to ten packages.
 *
 * `@electric-sql/pglite` is the one external: it loads its own WebAssembly
 * relative to itself, and it has no dependencies of its own, so it can be
 * copied into a packaged app as a directory. Everything else — pino
 * included — bundles, which matters because pnpm's node_modules is a tree of
 * symlinks that does not survive being copied into an app bundle.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const out = `${here}dist`;

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [`${here}src/index.ts`],
  outfile: `${out}/api.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["@electric-sql/pglite"],
  // Bundled ESM still contains CommonJS dependencies that call require().
  banner: {
    js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
});

// Read at runtime, so they travel with the bundle (see packages/db/client.ts).
cpSync(`${here}../../packages/db/migrations`, `${out}/migrations`, { recursive: true });
