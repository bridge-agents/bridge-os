import { describe, expect, it } from "vitest";
import { externalLink, isAppNavigation } from "./navigation.js";

describe("desktop navigation boundary", () => {
  it("allows ordinary browser and email links", () => {
    expect(externalLink("https://example.com/docs")).toBe("https://example.com/docs");
    expect(externalLink("http://localhost:3000")).toBe("http://localhost:3000/");
    expect(externalLink("mailto:help@example.com")).toBe("mailto:help@example.com");
  });

  it.each([
    "file:///Applications/Calculator.app",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vscode://file/etc/passwd",
    "bridge://approvals",
    "https://user:password@example.com",
    "not a URL",
  ])("does not hand unsafe renderer URLs to the OS: %s", (url) => {
    expect(externalLink(url)).toBeUndefined();
  });

  it("keeps routes and query parameters on the application's exact origin", () => {
    expect(
      isAppNavigation("https://bridge.example/chat?next=1#last", "https://bridge.example"),
    ).toBe(true);
    expect(isAppNavigation("http://127.0.0.1:4123/agents", "http://127.0.0.1:4123")).toBe(true);
  });

  it.each([
    "https://bridge.example.attacker.test/chat",
    "https://bridge.example@attacker.test/chat",
    "http://bridge.example/chat",
    "https://bridge.example:444/chat",
    "https://user:password@bridge.example/chat",
    "file:///tmp/index.html",
    "javascript:alert(1)",
  ])("blocks origin lookalikes and privileged schemes: %s", (url) => {
    expect(isAppNavigation(url, "https://bridge.example")).toBe(false);
  });

  it("blocks renderer navigation before the app URL is available", () => {
    expect(isAppNavigation("https://example.com", undefined)).toBe(false);
    expect(isAppNavigation("https://example.com", "invalid")).toBe(false);
  });
});
