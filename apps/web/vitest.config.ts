import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(appRoot, "src"),
    },
  },
  test: {
    // The renderer is DOM code; happy-dom is enough for it and is far
    // lighter than a full browser. Dev-only — nothing here ships.
    environment: "happy-dom",
    globals: false,
  },
});
