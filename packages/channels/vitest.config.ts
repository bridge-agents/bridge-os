import { defineConfig } from "vitest/config";
import { infrastructureTimeouts } from "../../vitest.shared.js";

// Channel tests stand up a database per test, and drive polling adapters.
export default defineConfig({ test: { ...infrastructureTimeouts } });
