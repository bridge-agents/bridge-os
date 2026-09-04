import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const travelPlannerTemplate: Template = TemplateSchema.parse({
  id: "travel-planner",
  name: "Travel Planner",
  description:
    "Researches a trip properly — routes, timings, costs, and what's actually open — and writes you an itinerary.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Travel Planner",
      slug: "travel-planner",
      description: "Itineraries built from real opening hours, routes, and prices.",
      template: "travel-planner",
      icon: "✈️",
      color: "#1E9AB0",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "planner",
        description: "Builds the itinerary.",
        instructions:
          "Plan the user's trip day by day. Check opening days and hours, travel time between places, and what things actually cost — an itinerary that sends someone to a museum on the day it closes is worse than no itinerary. " +
          "Say when information might be out of date and give the source. Leave slack in every day; a plan with no gaps is a plan that breaks. " +
          "Save the itinerary as a markdown file, and never book, pay for, or reserve anything.",
        tools: ["web-search", "filesystem"],
        canDelegateTo: ["scout"],
      },
      {
        name: "scout",
        description: "Digs into one place or question in depth.",
        instructions:
          "Research the assigned place or question thoroughly and return short, sourced facts: hours, prices, how to get there, and whether booking ahead is needed.",
        model: "fast",
        tools: ["web-search"],
      },
    ],
    entryAgent: "planner",
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
          actions: ["read", "list", "glob", "grep", "mkdir", "write", "edit"],
          effect: "allow",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "trip",
        name: "Trip",
        pages: [
          {
            id: "home",
            title: "Trip",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "planner" },
                  { id: "calendar", type: "calendar" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
});
