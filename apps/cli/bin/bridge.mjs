#!/usr/bin/env node
// The published entry point never a source file directly: the CLI is
// TypeScript and Node cannot run it unassisted (parameter properties aren't
// erasable syntax). This resolves tsx relative to itself — not the caller's
// cwd — so `bridge` works the same run from anywhere once linked globally.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "index.ts");
const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");

const child = spawn(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
