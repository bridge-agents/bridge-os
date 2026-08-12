import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

/**
 * Reference template proving the templates-as-data model. Also used as the
 * canonical valid-manifest fixture across the repo's tests.
 */
export const personalAssistantTemplate: Template = TemplateSchema.parse({
  id: "personal-assistant",
  name: "Personal Assistant",
  description:
    "A day-to-day assistant that manages tasks and research, with a morning briefing schedule.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 1,
    meta: {
      name: "Personal Assistant",
      slug: "personal-assistant",
      description: "Handles daily tasks, research and briefings.",
      template: "personal-assistant",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
    },
    agents: [
      {
        name: "assistant",
        description: "Primary assistant and orchestrator.",
        instructions:
          "You are the user's personal assistant. Manage their tasks, answer questions, and delegate research to the researcher agent when a question needs depth.",
        tools: ["web-search"],
        canDelegateTo: ["researcher"],
      },
      {
        name: "researcher",
        description: "Deep research subagent.",
        instructions:
          "Research the given topic thoroughly using web search and return a concise, sourced summary.",
        model: "fast",
        tools: ["web-search"],
      },
    ],
    entryAgent: "assistant",
    tools: [{ name: "web-search", kind: "native" }],
    memory: { longTerm: true },
    permissions: {
      default: "ask",
      rules: [{ resource: "tool:web-search", actions: "*", effect: "allow" }],
    },
    triggers: {
      schedules: [
        {
          name: "morning-brief",
          cron: "0 7 * * 1-5",
          input: "Prepare my morning briefing: today's tasks, calendar, and anything urgent.",
        },
      ],
    },
    dashboard: {
      version: 1,
      name: "Personal",
      pages: [
        {
          id: "home",
          title: "Home",
          sections: [
            {
              id: "overview",
              widgets: [
                { id: "status", type: "agentStatus", agent: "assistant" },
                { id: "tasks", type: "taskList" },
                { id: "activity", type: "activity" },
              ],
            },
          ],
        },
      ],
    },
  }),
});
