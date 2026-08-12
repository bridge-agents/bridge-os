import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv } from "./env.js";
import { BridgeError } from "./errors.js";
import { id, newAgentId } from "./ids.js";

describe("ids", () => {
  it("prefixes and is unique", () => {
    expect(newAgentId()).toMatch(/^agt_[0-9a-f]{32}$/);
    expect(id("x")).not.toBe(id("x"));
  });
});

describe("BridgeError", () => {
  it("maps codes to http statuses", () => {
    expect(new BridgeError("not_found", "missing").httpStatus).toBe(404);
    expect(new BridgeError("validation_failed", "bad", { field: "slug" }).httpStatus).toBe(422);
  });
});

describe("loadEnv", () => {
  const schema = z.object({
    REQUIRED_URL: z.string().min(1),
    PORT: z.coerce.number().default(4000),
  });

  it("parses with defaults", () => {
    const env = loadEnv(schema, { REQUIRED_URL: "postgres://x" });
    expect(env.PORT).toBe(4000);
  });

  it("fails fast with readable message", () => {
    expect(() => loadEnv(schema, {})).toThrow(/REQUIRED_URL/);
  });
});
