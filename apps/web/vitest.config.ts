import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The renderer is DOM code; happy-dom is enough for it and is far
    // lighter than a full browser. Dev-only — nothing here ships.
    environment: "happy-dom",
    globals: false,
  },
});
