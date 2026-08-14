import type { Dashboard } from "./dashboard.js";

/**
 * Dashboard templates, as data.
 *
 * They are ordinary Dashboard values, validated by the same schema as an
 * AI-generated or hand-edited one — a template that could not be produced by
 * editing would be a second, privileged representation (invariant 1).
 *
 * Every widget binds to a source that resolves today. A template that ships
 * with a dead panel teaches the user the product is broken.
 */

export interface DashboardTemplate {
  id: string;
  name: string;
  description: string;
  dashboard: Dashboard;
}

const overview: Dashboard = {
  version: 1,
  name: "Overview",
  theme: { accent: "#CCD5DF", appearance: "system" },
  pages: [
    {
      id: "overview",
      title: "Overview",
      sections: [
        {
          id: "at-a-glance",
          title: "At a glance",
          widgets: [
            { id: "active", type: "metric", title: "Running now", source: "runs.active" },
            {
              id: "pending",
              type: "metric",
              title: "Waiting on you",
              source: "approvals.pending.count",
            },
            {
              id: "deployed",
              type: "metric",
              title: "Deployed agents",
              source: "agents.deployed.count",
            },
            { id: "spend", type: "metric", title: "Total spend", source: "runs.cost.total" },
          ],
        },
        {
          id: "trend",
          title: "Activity",
          widgets: [
            {
              id: "runs-daily",
              type: "chart",
              title: "Runs per day",
              source: "runs.count.daily",
              chartType: "bar",
            },
            {
              id: "cost-daily",
              type: "chart",
              title: "Spend per day",
              source: "runs.cost.daily",
              chartType: "area",
            },
          ],
        },
        {
          id: "queue",
          title: "Needs a human",
          widgets: [{ id: "approvals", type: "approvalQueue", title: "Approvals" }],
        },
        {
          id: "recent",
          title: "Recent runs",
          widgets: [{ id: "runs-table", type: "table", title: "Runs", source: "runs.recent" }],
        },
      ],
    },
  ],
};

const spend: Dashboard = {
  version: 1,
  name: "Spend",
  theme: { accent: "#CCD5DF", appearance: "system" },
  pages: [
    {
      id: "spend",
      title: "Spend",
      sections: [
        {
          id: "totals",
          title: "Totals",
          widgets: [
            { id: "cost", type: "metric", title: "Total spend", source: "runs.cost.total" },
            { id: "tokens", type: "metric", title: "Total tokens", source: "runs.tokens.total" },
            { id: "runs", type: "metric", title: "Runs", source: "runs.total" },
          ],
        },
        {
          id: "over-time",
          title: "Over time",
          widgets: [
            {
              id: "cost-daily",
              type: "chart",
              title: "Spend per day",
              source: "runs.cost.daily",
              chartType: "area",
            },
            {
              id: "tokens-daily",
              type: "chart",
              title: "Tokens per day",
              source: "runs.tokens.daily",
              chartType: "bar",
            },
          ],
        },
        {
          id: "detail",
          title: "By run",
          widgets: [
            { id: "runs-table", type: "table", title: "Recent runs", source: "runs.recent" },
          ],
        },
      ],
    },
  ],
};

const operations: Dashboard = {
  version: 1,
  name: "Operations",
  theme: { accent: "#CCD5DF", appearance: "system" },
  pages: [
    {
      id: "operations",
      title: "Operations",
      sections: [
        {
          id: "health",
          title: "Health",
          widgets: [
            { id: "active", type: "metric", title: "In flight", source: "runs.active" },
            {
              id: "pending",
              type: "metric",
              title: "Blocked on approval",
              source: "approvals.pending.count",
            },
          ],
        },
        {
          id: "fleet",
          title: "Fleet",
          widgets: [{ id: "agents", type: "table", title: "Agents", source: "agents.all" }],
        },
        {
          id: "failures",
          title: "Failures",
          widgets: [
            { id: "failed", type: "table", title: "Recent failures", source: "runs.failed.recent" },
          ],
        },
        {
          id: "trace",
          title: "Trace",
          widgets: [{ id: "logs", type: "logs", title: "Recent steps", source: "logs.recent" }],
        },
      ],
    },
  ],
};

const activity: Dashboard = {
  version: 1,
  name: "Activity",
  theme: { accent: "#CCD5DF", appearance: "system" },
  pages: [
    {
      id: "activity",
      title: "Activity",
      sections: [
        {
          id: "pulse",
          title: "Pulse",
          widgets: [
            {
              id: "runs-daily",
              type: "chart",
              title: "Runs per day",
              source: "runs.count.daily",
              chartType: "line",
            },
          ],
        },
        {
          id: "stream",
          title: "What happened",
          widgets: [
            { id: "events", type: "activity", title: "Recent activity", source: "events.recent" },
          ],
        },
        {
          id: "agents",
          title: "Agents",
          widgets: [{ id: "status", type: "agentStatus", title: "Agent status" }],
        },
      ],
    },
  ],
};

export const dashboardTemplates: DashboardTemplate[] = [
  {
    id: "overview",
    name: "Overview",
    description: "Everything at a glance: what is running, what needs you, what it cost.",
    dashboard: overview,
  },
  {
    id: "spend",
    name: "Spend",
    description: "Where the money and tokens go, by day and by run.",
    dashboard: spend,
  },
  {
    id: "operations",
    name: "Operations",
    description: "Fleet health, failures and the execution trace.",
    dashboard: operations,
  },
  {
    id: "activity",
    name: "Activity",
    description: "A running log of what your agents have been doing.",
    dashboard: activity,
  },
];

export function getDashboardTemplate(id: string): DashboardTemplate | undefined {
  return dashboardTemplates.find((template) => template.id === id);
}

/** The smallest dashboard that is still valid — the "start from scratch" case. */
export function blankDashboard(name = "Dashboard"): Dashboard {
  return {
    version: 1,
    name,
    theme: { accent: "#CCD5DF", appearance: "system" },
    pages: [
      {
        id: "home",
        title: "Home",
        sections: [
          {
            id: "start",
            title: "Start here",
            widgets: [{ id: "runs", type: "metric", title: "Runs", source: "runs.total" }],
          },
        ],
      },
    ],
  };
}
