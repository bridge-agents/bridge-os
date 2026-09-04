import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const studyBuddyTemplate: Template = TemplateSchema.parse({
  id: "study-buddy",
  name: "Study Buddy",
  description:
    "Turns your notes into questions, quizzes you on a schedule, and keeps track of what you keep forgetting.",
  category: "education",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Study Buddy",
      slug: "study-buddy",
      description: "Spaced-repetition study partner built on your own notes.",
      template: "study-buddy",
      icon: "📚",
      color: "#7A5AF8",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "tutor",
        description: "Teaches, quizzes, and tracks what needs work.",
        instructions:
          "You help the user learn from their own notes. Read what they give you and turn it into questions that test understanding, not recall of phrasing. " +
          "When they answer, say plainly whether they are right, and if not, explain the gap rather than restating the answer. " +
          "Keep a file of the things they get wrong and bring those back sooner than the things they get right — that spacing is the whole point. " +
          "Never make them feel stupid, and never pretend a wrong answer was close if it wasn't.",
        tools: ["filesystem", "web-search"],
      },
    ],
    entryAgent: "tutor",
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
    triggers: {
      schedules: [
        {
          name: "evening-review",
          cron: "0 19 * * *",
          input: "Quiz me on what I'm due to review, weighting what I keep getting wrong.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "study",
        name: "Study",
        pages: [
          {
            id: "home",
            title: "Study",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "chat", type: "chat", agent: "tutor" },
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
