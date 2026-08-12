import { describe, expect, it } from "vitest";
import { safeParseManifest } from "./manifest.js";
import { TemplateSchema } from "./template.js";
import { getTemplate, instantiateTemplate, slugify, templates } from "./templates/index.js";

describe("template catalog", () => {
  it("every template is valid data with a valid manifest", () => {
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(TemplateSchema.safeParse(template).success).toBe(true);
      expect(safeParseManifest(template.manifest).success).toBe(true);
    }
  });

  it("template ids are unique", () => {
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("looks templates up by id", () => {
    expect(getTemplate("personal-assistant")?.name).toBe("Personal Assistant");
    expect(getTemplate("nope")).toBeUndefined();
  });
});

describe("instantiateTemplate", () => {
  it("produces a valid manifest carrying the template id", () => {
    const template = getTemplate("software-team");
    if (!template) throw new Error("missing fixture");
    const manifest = instantiateTemplate(template, { name: "My Dev Team" });

    expect(safeParseManifest(manifest).success).toBe(true);
    expect(manifest.meta.name).toBe("My Dev Team");
    expect(manifest.meta.slug).toBe("my-dev-team");
    expect(manifest.meta.template).toBe("software-team");
    expect(manifest.agents).toHaveLength(3);
  });

  it("does not share state with the catalog copy", () => {
    const template = getTemplate("research-agent");
    if (!template) throw new Error("missing fixture");
    const manifest = instantiateTemplate(template, { name: "Mine" });
    manifest.agents[0]?.tools.push("mutated");

    expect(template.manifest.agents[0]?.tools).not.toContain("mutated");
  });

  it("defaults to the template name when none is given", () => {
    const template = getTemplate("personal-assistant");
    if (!template) throw new Error("missing fixture");
    expect(instantiateTemplate(template).meta.name).toBe("Personal Assistant");
  });
});

describe("slugify", () => {
  it.each([
    ["My Dev Team", "my-dev-team"],
    ["  Spaces  Everywhere ", "spaces-everywhere"],
    ["Ünïcødé & symbols!", "n-c-d-symbols"],
    ["123 numbers", "123-numbers"],
    ["!!!", "agent"],
    ["", "agent"],
  ])("%s → %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
