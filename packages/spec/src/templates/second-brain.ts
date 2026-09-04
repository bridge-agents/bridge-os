import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const secondBrainTemplate: Template = TemplateSchema.parse({
  id: "second-brain",
  name: "Second Brain",
  description:
    "Files everything you throw at it, connects it to what you already knew, and finds it again when you need it.",
  category: "personal",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Second Brain",
      slug: "second-brain",
      description: "A notes system that organises and connects itself.",
      template: "second-brain",
      icon: "🧠",
      color: "#9B59B6",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "librarian",
        description: "Files, links, and retrieves everything the user saves.",
        instructions:
          "You keep the user's notes. When they give you something — a link, a thought, a document — write it into a markdown file with a clear title, and link it to the notes it relates to. " +
          "Never file something twice: search first, and if a note on the topic exists, extend it rather than creating a near-duplicate. " +
          "When asked a question, answer from their own notes first and say which note it came from. Only search the web when their notes do not have it, and mark clearly which is which.",
        tools: ["filesystem", "web-search"],
      },
    ],
    entryAgent: "librarian",
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
    dashboards: [
      {
        version: 1,
        id: "notes",
        name: "Notes",
        pages: [
          {
            id: "home",
            title: "Notes",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "librarian" },
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
