import { parseManifest } from "../manifest.js";
import { type Template, TemplateSchema } from "../template.js";

export const researchAgentTemplate: Template = TemplateSchema.parse({
  id: "research-agent",
  name: "Research Agent",
  description: "Researches topics in depth and keeps a written knowledge base of what it learns.",
  category: "research",
  manifest: parseManifest({
    specVersion: 1,
    meta: {
      name: "Research Agent",
      slug: "research-agent",
      description: "Deep research with sourced summaries.",
      template: "research-agent",
    },
    models: {
      default: { provider: "anthropic", model: "claude-sonnet-5" },
      roles: { reasoning: { provider: "anthropic", model: "claude-opus-5" } },
    },
    agents: [
      {
        name: "researcher",
        description: "Researches and synthesises.",
        instructions:
          "Research the user's question thoroughly. Prefer primary sources, state what you could not verify, and always cite where each claim came from.",
        model: "reasoning",
        tools: ["web-search", "http"],
        memory: { longTerm: true },
      },
    ],
    entryAgent: "researcher",
    tools: [
      { name: "web-search", kind: "native" },
      { name: "http", kind: "http" },
    ],
    memory: { longTerm: true, knowledge: true },
    permissions: {
      default: "ask",
      rules: [
        { resource: "tool:web-search", actions: "*", effect: "allow" },
        { resource: "tool:http", actions: ["read"], effect: "allow" },
      ],
    },
  }),
});
