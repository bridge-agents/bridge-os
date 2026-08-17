import { defineConfig } from "vitest/config";
import { infrastructureTimeouts } from "../../vitest.shared.js";

// The supervisor tests spawn real child processes and wait for them to serve.
export default defineConfig({ test: { ...infrastructureTimeouts } });
