import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const recruiterTemplate: Template = TemplateSchema.parse({
  id: "recruiter",
  name: "Hiring Assistant",
  description:
    "Reads applications against the job description, summarises each candidate, and flags the ones worth your time.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Hiring Assistant",
      slug: "hiring-assistant",
      description: "Screens applications consistently and shows its reasoning.",
      template: "recruiter",
      icon: "🧑‍💼",
      color: "#3E7C8C",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { careful: { provider: "anthropic", model: "claude-opus-5" } },
    },
    agents: [
      {
        name: "screener",
        description: "Reads applications and summarises them against the role.",
        instructions:
          "Read each application against the job description in your workspace and nothing else. " +
          "For each candidate write: what they have done that matches the role, what is missing, and one question worth asking them. Quote the evidence. " +
          "Judge only demonstrated work and stated experience. Do not infer or comment on age, sex, race, nationality, health, family, or where someone went to school — none of it predicts the work, and weighing it is both wrong and in most places illegal. " +
          "Never rank candidates by a single score. You produce a summary a human uses to decide; you do not decide.",
        model: "careful",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "screener",
    tools: [{ name: "filesystem", kind: "native" }],
    memory: { longTerm: true },
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
    dashboards: [
      {
        version: 1,
        id: "hiring",
        name: "Hiring",
        pages: [
          {
            id: "home",
            title: "Candidates",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "screener" },
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
