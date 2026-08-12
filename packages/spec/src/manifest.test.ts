import { describe, expect, it } from "vitest";
import { parseManifest, SPEC_VERSION, safeParseManifest } from "./manifest.js";
import { personalAssistantTemplate } from "./templates/personal-assistant.js";

const valid = () => structuredClone(personalAssistantTemplate.manifest);

describe("ManifestSchema", () => {
  it("accepts the reference template manifest", () => {
    const manifest = parseManifest(valid());
    expect(manifest.specVersion).toBe(SPEC_VERSION);
    expect(manifest.entryAgent).toBe("assistant");
    expect(manifest.agents).toHaveLength(2);
  });

  it("applies defaults", () => {
    const manifest = parseManifest({
      specVersion: 1,
      meta: { name: "Min", slug: "min" },
      models: { default: { provider: "openai", model: "gpt-5" } },
      agents: [{ name: "main", instructions: "Do the thing." }],
      entryAgent: "main",
    });
    expect(manifest.permissions.default).toBe("ask");
    expect(manifest.runtime.limits.maxConcurrentRuns).toBe(1);
    expect(manifest.runtime.sandbox.network).toBe("restricted");
    expect(manifest.tools).toEqual([]);
    // Consumer default: runs on the user's own device, foreground only.
    expect(manifest.deployment).toEqual({ target: "local", background: false });
  });

  it("moves between deployment targets without any other change", () => {
    const local = parseManifest(valid());
    const cloud = parseManifest({ ...local, deployment: { target: "cloud", background: true } });
    const { deployment: _local, ...localRest } = local;
    const { deployment: _cloud, ...cloudRest } = cloud;
    expect(cloudRest).toEqual(localRest);
    expect(cloud.deployment.target).toBe("cloud");
  });

  it("rejects unknown deployment targets", () => {
    expect(
      safeParseManifest({ ...valid(), deployment: { target: "someones-laptop" } }).success,
    ).toBe(false);
  });

  it("rejects unknown entryAgent", () => {
    const bad = { ...valid(), entryAgent: "nobody" };
    const result = safeParseManifest(bad);
    expect(result.success).toBe(false);
  });

  it("rejects references to undeclared tools", () => {
    const bad = valid();
    bad.agents[0]?.tools.push("gmail");
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects unknown model roles", () => {
    const bad = valid();
    if (bad.agents[1]) bad.agents[1].model = "no-such-role";
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects unknown delegation targets", () => {
    const bad = valid();
    bad.agents[0]?.canDelegateTo.push("ghost");
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects duplicate agent names", () => {
    const bad = valid();
    const first = bad.agents[0];
    if (first) bad.agents.push(structuredClone(first));
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("rejects triggers pointing at unknown agents", () => {
    const bad = valid();
    const schedule = bad.triggers.schedules[0];
    if (schedule) schedule.agent = "ghost";
    expect(safeParseManifest(bad).success).toBe(false);
  });

  it("round-trips through JSON (serialisable)", () => {
    const manifest = parseManifest(valid());
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
});
