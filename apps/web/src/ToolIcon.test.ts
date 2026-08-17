import { describe, expect, it } from "vitest";
import { toolIconKey } from "./ToolIcon.js";

describe("tool icons", () => {
  it("resolves manifest grants and MCP tool-call names to the same brand", () => {
    expect(toolIconKey("github")).toBe("github");
    expect(toolIconKey("mcp__github__list_pull_requests")).toBe("github");
    expect(toolIconKey("Google Calendar")).toBe("google-calendar");
  });

  it("recognizes native activity labels and delegated runs", () => {
    expect(toolIconKey("filesystem.read_file")).toBe("filesystem");
    expect(toolIconKey("web_search")).toBe("web-search");
    expect(toolIconKey("Delegate to researcher")).toBe("delegate");
  });
});
