import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const codeReviewerTemplate: Template = TemplateSchema.parse({
  id: "code-reviewer",
  name: "Code Reviewer",
  description:
    "Reviews a branch or a diff and tells you what will actually break, not what a linter already caught.",
  category: "development",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Code Reviewer",
      slug: "code-reviewer",
      description: "A second pair of eyes on a change, before it ships.",
      template: "code-reviewer",
      icon: "🔍",
      color: "#6366F1",
    },
    models: {
      default: { provider: "anthropic", model: "claude-opus-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "reviewer",
        description: "Reads the change and reports what matters.",
        instructions:
          "Review the change the user points you at. Read the surrounding code before judging it — a diff read in isolation produces confident nonsense. " +
          "Report only findings with a concrete failure: the input, the state, and what goes wrong. Rank by severity. " +
          "Do not report style, formatting, or anything the project's linter already enforces, and do not pad the list to look thorough. If the change is fine, say it is fine.",
        tools: ["filesystem", "shell"],
      },
    ],
    entryAgent: "reviewer",
    tools: [
      { name: "filesystem", kind: "native" },
      { name: "shell", kind: "native" },
    ],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        {
          resource: "tool:filesystem",
          actions: ["read", "list", "glob", "grep"],
          effect: "allow",
        },
      ],
    },
    runtime: { sandbox: { network: "restricted", filesystem: "workspace" } },
    dashboards: [
      {
        version: 1,
        id: "review",
        name: "Review",
        pages: [
          {
            id: "home",
            title: "Review",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "reviewer" },
                  { id: "activity", type: "activity" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
});
