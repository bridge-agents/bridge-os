import { createLogger } from "@bridge/core";
import { describe, expect, it } from "vitest";
import { processJob } from "./jobs.js";

const deps = { logger: createLogger("test") };

describe("processJob", () => {
  it("handles heartbeat", async () => {
    const result = await processJob({ name: "heartbeat", data: {} }, deps);
    expect(result.ok).toBe(true);
  });

  it("rejects unknown jobs", async () => {
    await expect(processJob({ name: "mystery", data: {} }, deps)).rejects.toThrow(/unknown job/);
  });
});
