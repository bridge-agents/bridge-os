import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const fitnessCoachTemplate: Template = TemplateSchema.parse({
  id: "fitness-coach",
  name: "Fitness Coach",
  description:
    "Plans your training week, logs what you actually did, and adjusts when life gets in the way.",
  category: "fitness",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Fitness Coach",
      slug: "fitness-coach",
      description: "Training plans that adapt to the week you actually had.",
      template: "fitness-coach",
      icon: "🏃",
      color: "#3AAE5F",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "coach",
        description: "Plans, logs, and adjusts training.",
        instructions:
          "You coach the user's training. Keep a log file of every session they report: what they did, how it felt, and anything that hurt. " +
          "Plan the coming week from that log, not from a generic template — if they missed three sessions, the plan changes, it does not repeat. " +
          "Progress load gradually and say why each week differs from the last. " +
          "You are not a doctor: if they describe pain that is sharp, persistent, or in a joint, say plainly that this needs a medical opinion and do not program around it.",
        tools: ["filesystem", "web-search"],
      },
    ],
    entryAgent: "coach",
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
          name: "weekly-plan",
          cron: "0 18 * * 0",
          input: "Review my week and plan the next one.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "training",
        name: "Training",
        pages: [
          {
            id: "home",
            title: "This week",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "calendar", type: "calendar" },
                  { id: "tasks", type: "taskList" },
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
