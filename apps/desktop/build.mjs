import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * The Electron main process, bundled the same way the API is.
 *
 * `electron-updater` stays external because electron-builder needs to see it
 * as a real dependency to wire the update feed; everything else collapses
 * into one file so the packaged app has no node_modules of its own to
 * resolve at startup.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

await build({
  entryPoints: [`${here}src/main.ts`],
  outfile: `${here}dist/main.mjs`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["electron", "electron-updater"],
  banner: {
    js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
});
