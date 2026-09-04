import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const salesPipelineTemplate: Template = TemplateSchema.parse({
  id: "sales-pipeline",
  name: "Sales Pipeline",
  description:
    "Researches leads before a call, keeps the pipeline current, and reminds you who has gone quiet.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Sales Pipeline",
      slug: "sales-pipeline",
      description: "Lead research and pipeline hygiene, without the busywork.",
      template: "sales-pipeline",
      icon: "📈",
      color: "#C9973F",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "pipeline",
        description: "Keeps the deal list honest and prepares you for calls.",
        instructions:
          "You keep the user's pipeline current. Maintain one file per open deal: who, what they need, what was last said, what happens next, and when. " +
          "Before any call, hand the company to the researcher and turn what comes back into a one-page prep: who they are, what changed recently, and the three questions worth asking. " +
          "Each week, name the deals that have gone quiet and say how long it has been. Never contact anyone yourself.",
        tools: ["filesystem", "web-search"],
        canDelegateTo: ["researcher"],
      },
      {
        name: "researcher",
        description: "Researches a company or a person before a call.",
        instructions:
          "Research the assigned company: what they do, size, recent news, funding, and anything that changed in the last quarter. Return short sourced bullets. " +
          "Use public information only, and say plainly when you could not find something rather than filling the gap with a plausible guess.",
        model: "fast",
        tools: ["web-search"],
      },
    ],
    entryAgent: "pipeline",
    tools: [
      { name: "filesystem", kind: "native" },
      { name: "web-search", kind: "native" },
    ],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        { resource: "tool:web-search", actions: "*", effect: "allow" },
        {
          resource: "tool:filesystem",
          actions: ["read", "list", "glob", "grep", "mkdir", "write", "edit"],
          effect: "allow",
        },
      ],
    },
    triggers: {
      schedules: [
        {
          name: "pipeline-review",
          cron: "0 8 * * 1",
          input: "Which deals have gone quiet, and what should I do about each one this week?",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "pipeline",
        name: "Pipeline",
        pages: [
          {
            id: "home",
            title: "Pipeline",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "pipeline" },
                  { id: "tasks", type: "taskList", title: "Follow-ups" },
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
