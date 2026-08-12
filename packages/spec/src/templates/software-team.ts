import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const softwareTeamTemplate: Template = TemplateSchema.parse({
  id: "software-team",
  name: "Software Development Team",
  description:
    "An orchestrator with planning, implementation and review agents. Code changes require approval.",
  category: "development",
  manifest: parseManifest({
    specVersion: 1,
    meta: {
      name: "Software Development Team",
      slug: "software-team",
      description: "Plans, implements and reviews software changes.",
      template: "software-team",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: {
        reasoning: { provider: "anthropic", model: "claude-opus-5" },
        critic: { provider: "openai", model: "gpt-5" },
      },
    },
    agents: [
      {
        name: "lead",
        description: "Breaks work down and delegates.",
        instructions:
          "You lead a small software team. Turn the user's request into a plan, delegate implementation to the developer, and always have the reviewer check changes before reporting back.",
        model: "reasoning",
        canDelegateTo: ["developer", "reviewer"],
      },
      {
        name: "developer",
        description: "Writes and edits code.",
        instructions:
          "Implement the assigned change. Keep diffs minimal and match the surrounding code style. Never push or deploy.",
        tools: ["filesystem", "shell", "github"],
      },
      {
        name: "reviewer",
        description: "Reviews changes for correctness.",
        instructions:
          "Review the proposed change for correctness, security and unintended side effects. Report concrete problems, not style opinions.",
        model: "critic",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "lead",
    tools: [
      { name: "filesystem", kind: "native" },
      { name: "shell", kind: "native" },
      { name: "github", kind: "mcp" },
    ],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        { resource: "tool:filesystem", actions: ["read"], effect: "allow" },
        { resource: "tool:github", actions: ["read"], effect: "allow" },
        // Writing code, running commands and anything that leaves the machine stays gated.
        { resource: "tool:shell", actions: "*", effect: "ask" },
      ],
    },
    runtime: { limits: { maxConcurrentRuns: 2, maxRunSeconds: 1800 } },
  }),
});
