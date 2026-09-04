import { parseManifest, personalAssistantTemplate } from "@bridge/spec";
import { describe, expect, it } from "vitest";
import type { Manifest } from "./api.js";
import {
  grantedTools,
  TOOL_CATALOG,
  toolAccess,
  toolSecretName,
  withoutTool,
  withTool,
  withToolAccess,
} from "./toolCatalog.js";

const template = () => structuredClone(personalAssistantTemplate.manifest) as unknown as Manifest;

const entry = (id: string) => {
  const found = TOOL_CATALOG.find((one) => one.id === id);
  if (!found) throw new Error(`no catalog entry for ${id}`);
  return found;
};

describe("tool catalog", () => {
  it("offers more than twenty connectors, and every one says how it connects", () => {
    const connectors = TOOL_CATALOG.filter((one) => one.kind === "mcp");
    expect(connectors.length).toBeGreaterThanOrEqual(20);
    for (const connector of connectors) {
      // Either Bridge can reach it, or it says plainly why it cannot.
      expect(Boolean(connector.url) !== Boolean(connector.unavailable)).toBe(true);
    }
    expect(new Set(TOOL_CATALOG.map((one) => one.id)).size).toBe(TOOL_CATALOG.length);
  });

  it("adds a built-in tool as a manifest the API will accept", () => {
    // A tool the template does not already carry, so this proves the add.
    expect(grantedTools(template())).not.toContain("http");
    const next = withTool(template(), entry("http"));

    expect(grantedTools(next)).toContain("http");
    expect(parseManifest(next).agents.every((agent) => agent.tools.includes("http"))).toBe(true);
  });

  it("adds a connector with its token, and lets the agent resolve that secret", () => {
    const secret = toolSecretName("github");
    const next = withTool(template(), entry("github"), secret);

    const parsed = parseManifest(next);
    const grant = parsed.tools.find((tool) => tool.name === "github");
    expect(grant).toMatchObject({
      kind: "mcp",
      config: { url: "https://api.githubcopilot.com/mcp/" },
      secretBindings: { "headers.authorization": secret },
    });
    /**
     * The manifest refuses a grant whose secret the agent has not been given,
     * so this assertion is the whole reason the secret is written per agent.
     */
    expect(parsed.agents.every((agent) => agent.secrets.includes(secret))).toBe(true);
  });

  it("does not add the same tool twice", () => {
    const once = withTool(template(), entry("shell"));
    const twice = withTool(once, entry("shell"));

    expect(grantedTools(twice).filter((name) => name === "shell")).toHaveLength(1);
    expect(parseManifest(twice).agents[0]?.tools.filter((name) => name === "shell")).toHaveLength(
      1,
    );
  });

  it("removes a tool from the grants, the agents, and the rules at once", () => {
    const next = withoutTool(template(), "filesystem");
    const parsed = parseManifest(next);

    expect(grantedTools(next)).not.toContain("filesystem");
    expect(parsed.agents.every((agent) => !agent.tools.includes("filesystem"))).toBe(true);
    /**
     * The manifest rejects an agent referencing a tool that no longer exists,
     * so leaving either half behind would make the agent unsaveable.
     */
    expect(parsed.permissions.rules.some((rule) => rule.resource === "tool:filesystem")).toBe(
      false,
    );
  });
});

describe("tool access levels", () => {
  it("reads the level a template already expresses", () => {
    const manifest = template();
    // The template allows web search outright and only safe file actions.
    expect(toolAccess(manifest, "web-search")).toBe("allow");
    expect(toolAccess(manifest, "filesystem")).toBe("safe");
    expect(toolAccess(manifest, "shell")).toBe("ask");
  });

  it.each(["ask", "safe", "allow", "deny"] as const)("round-trips %s", (access) => {
    const next = withToolAccess(template(), "filesystem", access);
    expect(toolAccess(next, "filesystem")).toBe(access);
    expect(parseManifest(next).permissions.default).toBe("ask");
  });

  /**
   * First match wins, so a new rule appended behind an old one would leave the
   * old answer in force — the setting would appear to save and change nothing.
   */
  it("replaces a tool's existing rules rather than stacking on them", () => {
    const denied = withToolAccess(template(), "web-search", "deny");
    const rules = denied.permissions.rules.filter((rule) => rule.resource === "tool:web-search");

    expect(rules).toHaveLength(1);
    expect(toolAccess(denied, "web-search")).toBe("deny");
  });

  it("leaves other tools' rules alone", () => {
    const next = withToolAccess(template(), "web-search", "deny");
    expect(toolAccess(next, "filesystem")).toBe("safe");
  });
});
