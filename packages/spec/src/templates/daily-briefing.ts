import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const dailyBriefingTemplate: Template = TemplateSchema.parse({
  id: "daily-briefing",
  name: "Daily Briefing",
  description:
    "One page every morning: what's on today, what changed in the news you follow, and what you said you'd do.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Daily Briefing",
      slug: "daily-briefing",
      description: "A single morning summary, delivered before you start.",
      template: "daily-briefing",
      icon: "☀️",
      color: "#E0A32E",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "briefer",
        description: "Writes the morning briefing.",
        instructions:
          "Write the user one short briefing each morning. Four sections, in this order: Today (what's scheduled), Watching (what changed in the topics they follow), Owed (what they said they would do), and One thing (the single most useful action for today). " +
          "Never pad. If a section has nothing in it, write 'Nothing' and move on — a briefing that invents content to look full is worse than a short one. " +
          "Save each briefing as a dated markdown file so they build into a record.",
        tools: ["web-search", "filesystem"],
      },
    ],
    entryAgent: "briefer",
    tools: [
      { name: "web-search", kind: "native" },
      { name: "filesystem", kind: "native" },
    ],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        { resource: "tool:web-search", actions: "*", effect: "allow" },
        {
          resource: "tool:filesystem",
          actions: ["read", "list", "glob", "grep", "mkdir", "write"],
          effect: "allow",
        },
      ],
    },
    triggers: {
      schedules: [
        {
          name: "morning-brief",
          cron: "0 7 * * *",
          input: "Write today's briefing.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "briefing",
        name: "Briefing",
        pages: [
          {
            id: "home",
            title: "Today",
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
