import { type ModelRef, SlugSchema } from "../common.js";
import { type Manifest, ManifestSchema, SPEC_VERSION } from "../manifest.js";
import type { Template } from "../template.js";
import { codeReviewerTemplate } from "./code-reviewer.js";
import { contentStudioTemplate } from "./content-studio.js";
import { customerSupportTemplate } from "./customer-support.js";
import { dailyBriefingTemplate } from "./daily-briefing.js";
import { dataAnalystTemplate } from "./data-analyst.js";
import { financeTrackerTemplate } from "./finance-tracker.js";
import { fitnessCoachTemplate } from "./fitness-coach.js";
import { homeAdminTemplate } from "./home-admin.js";
import { inboxManagerTemplate } from "./inbox-manager.js";
import { meetingNotesTemplate } from "./meeting-notes.js";
import { personalAssistantTemplate } from "./personal-assistant.js";
import { recruiterTemplate } from "./recruiter.js";
import { researchAgentTemplate } from "./research-agent.js";
import { salesPipelineTemplate } from "./sales-pipeline.js";
import { secondBrainTemplate } from "./second-brain.js";
import { siteMonitorTemplate } from "./site-monitor.js";
import { socialMediaTemplate } from "./social-media.js";
import { softwareTeamTemplate } from "./software-team.js";
import { studyBuddyTemplate } from "./study-buddy.js";
import { travelPlannerTemplate } from "./travel-planner.js";

/**
 * The template catalog is data. Adding a template means adding a file here —
 * never a branch somewhere in the engine.
 *
 * Every entry is meant to be usable the moment it is created: tools granted,
 * permissions drawn where the irreversible actions are, and a schedule where
 * the job is a recurring one. A template that needs a manual round of setup
 * before it does anything is a worked example, not a starting point.
 */
export const templates: readonly Template[] = [
  personalAssistantTemplate,
  dailyBriefingTemplate,
  secondBrainTemplate,
  inboxManagerTemplate,
  meetingNotesTemplate,
  contentStudioTemplate,
  customerSupportTemplate,
  salesPipelineTemplate,
  socialMediaTemplate,
  recruiterTemplate,
  softwareTeamTemplate,
  codeReviewerTemplate,
  siteMonitorTemplate,
  researchAgentTemplate,
  dataAnalystTemplate,
  studyBuddyTemplate,
  fitnessCoachTemplate,
  travelPlannerTemplate,
  homeAdminTemplate,
  financeTrackerTemplate,
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
  overrides: { name?: string; slug?: string; icon?: string; color?: string } = {},
): Manifest {
  const name = overrides.name?.trim() || template.manifest.meta.name;
  const slug = overrides.slug ?? slugify(name);
  return {
    ...structuredClone(template.manifest),
    meta: {
      ...template.manifest.meta,
      name,
      slug,
      template: template.id,
      ...(overrides.icon ? { icon: overrides.icon } : {}),
      ...(overrides.color ? { color: overrides.color } : {}),
    },
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
  icon?: string;
  color?: string;
}): Manifest {
  const name = input.name.trim() || "New Agent";
  return ManifestSchema.parse({
    specVersion: SPEC_VERSION,
    meta: {
      name,
      slug: slugify(name),
      ...(input.icon ? { icon: input.icon } : {}),
      ...(input.color ? { color: input.color } : {}),
    },
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

export {
  codeReviewerTemplate,
  contentStudioTemplate,
  customerSupportTemplate,
  dailyBriefingTemplate,
  dataAnalystTemplate,
  financeTrackerTemplate,
  fitnessCoachTemplate,
  homeAdminTemplate,
  inboxManagerTemplate,
  meetingNotesTemplate,
  personalAssistantTemplate,
  recruiterTemplate,
  researchAgentTemplate,
  salesPipelineTemplate,
  secondBrainTemplate,
  siteMonitorTemplate,
  socialMediaTemplate,
  softwareTeamTemplate,
  studyBuddyTemplate,
  travelPlannerTemplate,
};
