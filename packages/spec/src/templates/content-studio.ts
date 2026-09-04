import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const contentStudioTemplate: Template = TemplateSchema.parse({
  id: "content-studio",
  name: "Content Studio",
  description:
    "A writer, an editor and a researcher who turn a rough idea into a finished, fact-checked article.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Content Studio",
      slug: "content-studio",
      description: "Researches, drafts, and edits long-form writing.",
      template: "content-studio",
      icon: "✍️",
      color: "#B45FD8",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5" },
        careful: { provider: "anthropic", model: "claude-opus-5" },
      },
    },
    agents: [
      {
        name: "editor",
        description: "Runs the desk: takes the brief, assigns work, ships the piece.",
        instructions:
          "You are the editor. Take the user's idea and turn it into a brief: audience, angle, length, and the three things the piece must say. " +
          "Send the researcher out for facts, have the writer draft from the brief, then edit hard — cut throat-clearing, kill adverbs, and make every claim traceable to something the researcher found. " +
          "Save the finished piece as a markdown file and tell the user where it is.",
        model: "careful",
        tools: ["filesystem"],
        canDelegateTo: ["researcher", "writer"],
      },
      {
        name: "researcher",
        description: "Finds and verifies the facts the piece rests on.",
        instructions:
          "Research the assigned topic. Return a bulleted brief of verified facts, each with its source URL. " +
          "Flag anything you could only find on one source as unverified — the editor needs to know what is shaky.",
        model: "fast",
        tools: ["web-search", "filesystem"],
      },
      {
        name: "writer",
        description: "Writes the draft.",
        instructions:
          "Write from the editor's brief and the researcher's facts, and from nothing else. " +
          "Short sentences. Concrete nouns. No throat-clearing introductions, no summary paragraph restating what you just said. " +
          "If a claim is not in the research, do not make it.",
        tools: ["filesystem"],
      },
    ],
    entryAgent: "editor",
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
        id: "studio",
        name: "Studio",
        pages: [
          {
            id: "home",
            title: "Desk",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "editor" },
                  { id: "chat", type: "chat", agent: "editor" },
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
