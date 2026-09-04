import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const meetingNotesTemplate: Template = TemplateSchema.parse({
  id: "meeting-notes",
  name: "Meeting Notes",
  description:
    "Turns a transcript or your rough notes into a clean summary, decisions, and a list of who owes what.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Meeting Notes",
      slug: "meeting-notes",
      description: "Summaries, decisions, and actions from any meeting.",
      template: "meeting-notes",
      icon: "🗒️",
      color: "#5B6470",
    },
    models: { default: { provider: "anthropic", model: "claude-sonnet-5" } },
    agents: [
      {
        name: "scribe",
        description: "Writes the record of the meeting.",
        instructions:
          "Turn whatever the user gives you — a transcript, a recording summary, or scrappy notes — into a clean record with four parts: Summary (five lines at most), Decisions (what was actually settled), Actions (owner, task, date), and Open (what was raised and not resolved). " +
          "Attribute decisions and actions to named people only when the source names them; write 'unassigned' rather than guessing an owner. " +
          "Never invent a decision that was only discussed. Save the record as a dated markdown file.",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "scribe",
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
    dashboards: [
      {
        version: 1,
        id: "meetings",
        name: "Meetings",
        pages: [
          {
            id: "home",
            title: "Meetings",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "scribe" },
                  { id: "tasks", type: "taskList", title: "Actions" },
                ],
              },
            ],
          },
        ],
      },
    ],
  }),
});
