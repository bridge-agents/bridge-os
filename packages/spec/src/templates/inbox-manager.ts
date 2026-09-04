import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const inboxManagerTemplate: Template = TemplateSchema.parse({
  id: "inbox-manager",
  name: "Inbox Manager",
  description:
    "Reads your mail every morning, sorts what matters from what doesn't, and drafts replies for you to send.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Inbox Manager",
      slug: "inbox-manager",
      description: "Triages email and drafts replies, never sending without you.",
      template: "inbox-manager",
      icon: "📬",
      color: "#4F7CFF",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "triage",
        description: "Sorts the inbox and decides what needs a person.",
        instructions:
          "You triage the user's email. Each morning, read unread mail and sort it into: needs a reply from them, needs a reply you can draft, informational, and ignorable. " +
          "Draft replies for anything routine — scheduling, acknowledgements, simple answers — and leave them as drafts. Never send. " +
          "Hand anything long or sensitive to the writer agent for a careful draft. " +
          "Report back as a short list: what needs them, what you drafted, and what you ignored and why.",
        tools: ["gmail"],
        canDelegateTo: ["writer"],
      },
      {
        name: "writer",
        description: "Writes the replies that need care.",
        instructions:
          "Write email replies in the user's voice: direct, warm, and short. Match the register of the message you are answering. " +
          "Never invent facts, commitments, or dates — if something is unknown, leave an obvious [ ] placeholder for the user to fill.",
        tools: ["gmail"],
      },
    ],
    entryAgent: "triage",
    tools: [{ name: "gmail", kind: "mcp" }],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        /**
         * Reading and drafting are reversible; sending is not. A draft sitting
         * in the mailbox is a suggestion, and a sent message is an act taken
         * in the user's name — so the line is drawn exactly there.
         */
        {
          resource: "tool:gmail",
          actions: ["read", "search", "list", "draft", "label"],
          effect: "allow",
        },
        { resource: "tool:gmail", actions: ["send", "delete", "forward"], effect: "ask" },
      ],
    },
    triggers: {
      schedules: [
        {
          name: "morning-triage",
          cron: "0 8 * * 1-5",
          input:
            "Triage everything that arrived since yesterday. Draft what you can, and tell me what needs me.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "inbox",
        name: "Inbox",
        pages: [
          {
            id: "home",
            title: "Inbox",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "triage" },
                  { id: "approvals", type: "approvalQueue", title: "Waiting to send" },
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
