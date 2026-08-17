import { defineConfig } from "vitest/config";
import { infrastructureTimeouts } from "../../vitest.shared.js";

// Executor, loop and automation tests each build a database and run migrations.
export default defineConfig({ test: { ...infrastructureTimeouts } });
