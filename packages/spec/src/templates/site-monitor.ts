import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const siteMonitorTemplate: Template = TemplateSchema.parse({
  id: "site-monitor",
  name: "Site Monitor",
  description:
    "Checks that your sites and APIs are up every few minutes, and tells you the moment one isn't.",
  category: "development",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Site Monitor",
      slug: "site-monitor",
      description: "Uptime and health checks on a loop, with a written record.",
      template: "site-monitor",
      icon: "🛰️",
      color: "#D2603A",
    },
    models: { default: { provider: "anthropic", model: "claude-haiku-4-5" } },
    agents: [
      {
        name: "monitor",
        description: "Checks the endpoints and reports changes.",
        instructions:
          "Check each URL the user has listed in your watchlist file. Record status code and response time for each. " +
          "Only speak up when something changed: a site that went down, came back, or slowed by more than half. A monitor that reports 'all fine' every five minutes is one people stop reading. " +
          "Keep the full history in a log file so trends are visible even when you stay quiet.",
        tools: ["http", "filesystem"],
      },
    ],
    entryAgent: "monitor",
    tools: [
      { name: "http", kind: "native" },
      { name: "filesystem", kind: "native" },
    ],
    memory: { longTerm: true },
    permissions: {
      default: "ask",
      rules: [
        { resource: "tool:http", actions: ["read"], effect: "allow" },
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
          name: "health-check",
          every: "5m",
          input: "Check the watchlist and report anything that changed.",
          /**
           * A check that fails five times running is not a flaky endpoint, it
           * is a broken monitor — and one that keeps retrying forever spends
           * money to keep saying the same thing.
           */
          loop: { maxConsecutiveFailures: 5 },
        },
      ],
    },
    runtime: {
      limits: { maxConcurrentRuns: 1, maxRunSeconds: 120 },
      sandbox: { network: "full", filesystem: "workspace" },
    },
    dashboards: [
      {
        version: 1,
        id: "monitoring",
        name: "Monitoring",
        pages: [
          {
            id: "home",
            title: "Status",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "monitor" },
                  { id: "uptime", type: "chart", source: "runs.duration.daily", chartType: "line" },
                  { id: "logs", type: "logs" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
});
