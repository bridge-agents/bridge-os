import { type ModelRef, SlugSchema } from "../common.js";
import { type Manifest, ManifestSchema, SPEC_VERSION } from "../manifest.js";
import type { Template } from "../template.js";
import { personalAssistantTemplate } from "./personal-assistant.js";
import { researchAgentTemplate } from "./research-agent.js";
import { softwareTeamTemplate } from "./software-team.js";

/**
 * The template catalog is data. Adding a template means adding a file here —
 * never a branch somewhere in the engine.
 */
export const templates: readonly Template[] = [
  personalAssistantTemplate,
  softwareTeamTemplate,
  researchAgentTemplate,
];

export function getTemplate(id: string): Template | undefined {
  return templates.find((template) => template.id === id);
}

/**
 * Instantiate a template into a fresh manifest. Only identity is overridden;
 * customisation happens afterwards through the same validated edit path as
 * any other manifest change.
 */
export function instantiateTemplate(
  template: Template,
  overrides: { name?: string; slug?: string } = {},
): Manifest {
  const name = overrides.name?.trim() || template.manifest.meta.name;
  const slug = overrides.slug ?? slugify(name);
  return {
    ...structuredClone(template.manifest),
    meta: { ...template.manifest.meta, name, slug, template: template.id },
  };
}

/**
 * The "start from scratch" starting point: a single agent, no tools, nothing
 * permitted by default. It is an ordinary manifest, so blank and template
 * creation stay one code path.
 */
export function blankManifest(input: {
  name: string;
  instructions?: string;
  model?: ModelRef;
}): Manifest {
  const name = input.name.trim() || "New Agent";
  return ManifestSchema.parse({
    specVersion: SPEC_VERSION,
    meta: { name, slug: slugify(name) },
    models: { default: input.model ?? { provider: "anthropic", model: "claude-sonnet-5" } },
    agents: [
      {
        name: "main",
        instructions:
          input.instructions?.trim() || `You are ${name}. Help the user with their requests.`,
      },
    ],
    entryAgent: "main",
  });
}

/** Best-effort slug from a display name; callers validate the result. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return SlugSchema.safeParse(slug).success ? slug : "agent";
}

export { personalAssistantTemplate, researchAgentTemplate, softwareTeamTemplate };
