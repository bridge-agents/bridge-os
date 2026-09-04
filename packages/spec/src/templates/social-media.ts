import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const socialMediaTemplate: Template = TemplateSchema.parse({
  id: "social-media",
  name: "Social Media Manager",
  description:
    "Plans a week of posts, writes them in your voice, and shows you the queue before anything goes out.",
  category: "business",
  manifest: parseManifest({
    specVersion: 2,
    meta: {
      name: "Social Media Manager",
      slug: "social-media-manager",
      description: "Drafts and schedules posts; publishing always asks first.",
      template: "social-media",
      icon: "📣",
      color: "#E2557B",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { fast: { provider: "anthropic", model: "claude-haiku-4-5" } },
    },
    agents: [
      {
        name: "planner",
        description: "Decides what to post and when.",
        instructions:
          "Plan the user's posting week. Look at what they have published before, what is happening in their field, and what they told you they want to say. " +
          "Produce a plan of dated posts, hand each to the copywriter, and save the finished queue as a markdown file. " +
          "Never publish anything — the queue is a proposal until the user says otherwise.",
        tools: ["web-search", "filesystem"],
        canDelegateTo: ["copywriter"],
      },
      {
        name: "copywriter",
        description: "Writes the posts.",
        instructions:
          "Write each post in the user's voice, for the platform it is going to. Respect the platform's length. " +
          "No hashtag walls, no 'thread 🧵' theatre, no engagement bait. If a post needs an image, describe the image you would make.",
        model: "fast",
        tools: ["filesystem"],
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
    triggers: {
      schedules: [
        {
          name: "weekly-plan",
          cron: "0 9 * * 1",
          input: "Plan and draft this week's posts, then show me the queue.",
        },
      ],
    },
    dashboards: [
      {
        version: 1,
        id: "social",
        name: "Social",
        pages: [
          {
            id: "home",
            title: "Queue",
            sections: [
              {
                id: "overview",
                widgets: [
                  { id: "status", type: "agentStatus", agent: "planner" },
                  { id: "calendar", type: "calendar" },
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
