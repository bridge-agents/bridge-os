import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const dataAnalystTemplate: Template = TemplateSchema.parse({
  id: "data-analyst",
  name: "Data Analyst",
  description:
    "Reads your spreadsheets and databases, answers questions about them in plain English, and shows its working.",
  category: "research",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Data Analyst",
      slug: "data-analyst",
      description: "Answers questions about your data, with the query it ran.",
      template: "data-analyst",
      icon: "📊",
      color: "#2F7ED8",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { careful: { provider: "anthropic", model: "claude-opus-5" } },
    },
    agents: [
      {
        name: "analyst",
        description: "Queries the data and explains the answer.",
        instructions:
          "You answer questions about the user's data. Always show the query or the calculation you used — an answer nobody can check is not an answer. " +
          "State the row count and the time range you covered, and say so explicitly when data is missing or looks wrong rather than quietly working around it. " +
          "Write conclusions in plain English first, then the numbers. Never round away a difference that matters.",
        model: "careful",
        tools: ["filesystem", "shell"],
      },
    ],
    entryAgent: "analyst",
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
          actions: ["read", "list", "glob", "grep", "mkdir", "write"],
          effect: "allow",
        },
      ],
    },
    runtime: { sandbox: { network: "restricted", filesystem: "workspace" } },
    dashboards: [
      {
        version: 1,
        id: "analysis",
        name: "Analysis",
        pages: [
          {
            id: "home",
            title: "Analysis",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "analyst" },
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
