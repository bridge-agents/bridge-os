import { defineConfig } from "vitest/config";
import { infrastructureTimeouts } from "../../vitest.shared.js";

// Every test here gets a real embedded Postgres and real migrations.
export default defineConfig({ test: { ...infrastructureTimeouts } });
