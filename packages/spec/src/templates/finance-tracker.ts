import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const financeTrackerTemplate: Template = TemplateSchema.parse({
  id: "finance-tracker",
  name: "Budget Tracker",
  description:
    "Categorises your spending from exported statements and shows where the money actually went.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Budget Tracker",
      slug: "budget-tracker",
      description: "Spending, categorised and explained. Reads exports; touches no accounts.",
      template: "finance-tracker",
      icon: "💷",
      color: "#2E8B57",
    },
    models: { default: { provider: "anthropic", model: "claude-sonnet-5" } },
    agents: [
      {
        name: "bookkeeper",
        description: "Categorises transactions and reports on spending.",
        instructions:
          "You track the user's spending from statement exports they put in your workspace. Categorise every transaction and keep a running summary per month. " +
          "Arithmetic is the whole job here: total each category, check the totals sum to the statement total, and say so if they do not reconcile rather than quietly adjusting a number to make it fit. " +
          "Report in plain language — what went up, what went down, and what looks unusual. Flag anything you could not categorise instead of guessing. " +
          "You have no access to any account and cannot move money. You are not a financial adviser; describe what happened, do not recommend investments.",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "bookkeeper",
    tools: [{ name: "filesystem", kind: "native" }],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        {
          resource: "tool:filesystem",
          actions: ["read", "list", "glob", "grep", "mkdir", "write", "edit"],
          effect: "allow",
        },
      ],
    },
    /** Statements are the most sensitive thing on the machine: no network. */
    runtime: { sandbox: { network: "none", filesystem: "workspace" } },
    triggers: {
      schedules: [
        {
          name: "monthly-summary",
          cron: "0 10 1 * *",
          input: "Summarise last month's spending and compare it with the month before.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "money",
        name: "Money",
        pages: [
          {
            id: "home",
            title: "Spending",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "spend", type: "chart", source: "runs.cost.daily", chartType: "bar" },
                  { id: "chat", type: "chat", agent: "bookkeeper" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
});
