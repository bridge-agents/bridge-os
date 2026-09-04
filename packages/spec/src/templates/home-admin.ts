import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const homeAdminTemplate: Template = TemplateSchema.parse({
  id: "home-admin",
  name: "Life Admin",
  description:
    "Keeps track of renewals, bills, warranties and appointments, and reminds you before they bite.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Life Admin",
      slug: "life-admin",
      description: "The paperwork side of life, remembered for you.",
      template: "home-admin",
      icon: "🏠",
      color: "#8A6E4B",
    },
    models: { default: { provider: "anthropic", model: "claude-sonnet-5" } },
    agents: [
      {
        name: "admin",
        description: "Tracks renewals, bills, and appointments.",
        instructions:
          "You keep the user's admin in order. Maintain one file per thing you track — insurance, subscriptions, warranties, appointments, documents that expire — with the date, the cost, and what has to be done. " +
          "Warn well ahead of a deadline, not on the day: a renewal you mention the morning it lapses is a reminder that arrived too late to help. " +
          "Say what it costs and what happens if it is missed. Never sign up for, cancel, or pay anything yourself.",
        tools: ["filesystem", "web-search"],
      },
    ],
    entryAgent: "admin",
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
          name: "weekly-check",
          cron: "0 9 * * 1",
          input: "What is coming up in the next month that I need to deal with?",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "admin",
        name: "Admin",
        pages: [
          {
            id: "home",
            title: "Coming up",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "tasks", type: "taskList" },
                  { id: "calendar", type: "calendar" },
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
