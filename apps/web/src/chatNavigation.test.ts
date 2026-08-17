import { describe, expect, it } from "vitest";
import { chatSessionKey, newChatParams } from "./chatNavigation.js";

describe("new chat navigation", () => {
  it("preserves the selected agent without carrying over a conversation", () => {
    const params = newChatParams("agent-1");

    expect(params.get("agent")).toBe("agent-1");
    expect(params.has("conversation")).toBe(false);
    expect(chatSessionKey(params)).toMatch(/^draft:/);
  });

  it("creates a new assistant runtime for every click", () => {
    expect(chatSessionKey(newChatParams())).not.toBe(chatSessionKey(newChatParams()));
  });

  it("uses a persisted conversation as the runtime key when one is open", () => {
    expect(chatSessionKey(new URLSearchParams("conversation=conversation-1"))).toBe(
      "conversation-1",
    );
  });
});
