import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const customerSupportTemplate: Template = TemplateSchema.parse({
  id: "customer-support",
  name: "Customer Support",
  description:
    "Answers customer questions from your own docs, escalates what it cannot answer, and never guesses at refunds.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Customer Support",
      slug: "customer-support",
      description: "Front-line support that knows when to hand over to a human.",
      template: "customer-support",
      icon: "🎧",
      color: "#2FA37A",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "support",
        description: "Answers the customer.",
        instructions:
          "You answer customer questions using the documentation in your workspace and nothing else. " +
          "If the answer is not in the docs, say so plainly and escalate rather than guessing — a confident wrong answer costs more than a slow right one. " +
          "Never promise a refund, a discount, a date, or a feature. Those are the user's to give, so hand them over instead. " +
          "Keep replies short, specific, and free of apology padding.",
        tools: ["filesystem", "web-search"],
        canDelegateTo: ["escalation"],
      },
      {
        name: "escalation",
        description: "Packages what a human needs to take over.",
        instructions:
          "Write a handover note for a human: what the customer asked, what was already tried, what you could not determine, and the one decision the human needs to make. " +
          "No preamble — the person reading this is busy.",
        model: "fast",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "support",
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
          actions: ["read", "list", "glob", "grep", "mkdir", "write"],
          effect: "allow",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "support",
        name: "Support",
        pages: [
          {
            id: "home",
            title: "Queue",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "support" },
                  { id: "approvals", type: "approvalQueue", title: "Needs a human" },
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
