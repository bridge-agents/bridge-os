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

  /**
   * "Ready to set up" is the promise the catalog makes, so it is worth
   * asserting rather than trusting: a template that ships without a face, or
   * that quietly allows everything, is not the starting point someone
   * clicking "Use this" is expecting.
   */
  it("every template arrives ready to run", () => {
    for (const template of templates) {
      const { meta, permissions, agents, tools } = template.manifest;
      expect(meta.icon, `${template.id} has no icon`).toBeTruthy();
      expect(meta.color, `${template.id} has no colour`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(permissions.default, `${template.id} permits by default`).toBe("ask");

      const granted = new Set(tools.map((tool) => tool.name));
      for (const agent of agents) {
        expect(
          agent.instructions.length,
          `${template.id}/${agent.name} is barely instructed`,
        ).toBeGreaterThan(80);
        for (const tool of agent.tools) expect(granted.has(tool)).toBe(true);
      }
    }
  });

  it("covers every category a user can filter by", () => {
    const categories = new Set(templates.map((template) => template.category));
    for (const expected of ["personal", "business", "development", "research"]) {
      expect(categories.has(expected as never), `nothing in "${expected}"`).toBe(true);
    }
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
