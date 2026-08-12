import { createLogger } from "@bridge/core";
import { personalAssistantTemplate } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const app = buildApp({ logger: createLogger("test") });

interface ErrorBody {
  error: { code: string; message: string };
}

describe("api", () => {
  it("GET /health without a database", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { db: string } };
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("unconfigured");
  });

  it("GET /v1/meta", async () => {
    const res = await app.request("/v1/meta");
    const body = (await res.json()) as { name: string; specVersion: number };
    expect(body.name).toBe("bridge");
    expect(body.specVersion).toBe(1);
  });

  it("POST /v1/manifests/validate accepts a valid manifest", async () => {
    const res = await app.request("/v1/manifests/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(personalAssistantTemplate.manifest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; manifest: { entryAgent: string } };
    expect(body.valid).toBe(true);
    expect(body.manifest.entryAgent).toBe("assistant");
  });

  it("POST /v1/manifests/validate rejects an invalid manifest with issues", async () => {
    const res = await app.request("/v1/manifests/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specVersion: 1, meta: { name: "x", slug: "x" } }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { valid: boolean; issues: unknown[] };
    expect(body.valid).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("returns the consistent error envelope for unknown routes", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("not_found");
  });

  it("returns validation_failed for non-JSON bodies", async () => {
    const res = await app.request("/v1/manifests/validate", { method: "POST", body: "not json" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation_failed");
  });
});
