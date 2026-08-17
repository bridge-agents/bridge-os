import { describe, expect, it } from "vitest";
import { PALETTE_SIZE, suggestionsFor } from "./prompt.js";

const commands = [
  { name: "help", summary: "everything you can type" },
  { name: "model", summary: "switch model" },
  { name: "new", summary: "fresh conversation" },
  { name: "chats", summary: "recent conversations" },
  { name: "resume", summary: "continue one" },
  { name: "agents", summary: "list agents" },
  { name: "approvals", summary: "pending decisions" },
  { name: "runs", summary: "recent runs" },
];

describe("the command palette", () => {
  it("shows five the moment you type a slash, before Enter", () => {
    expect(suggestionsFor("/", commands)).toHaveLength(PALETTE_SIZE);
    expect(suggestionsFor("/", commands)[0]?.name).toBe("help");
  });

  it("narrows to what matches as you keep typing", () => {
    expect(suggestionsFor("/a", commands).map((one) => one.name)).toEqual([
      "agents",
      "approvals",
      "chats",
    ]);
    expect(suggestionsFor("/ap", commands).map((one) => one.name)).toEqual(["approvals"]);
  });

  it("still finds a command named from the middle", () => {
    // "sum" is inside "resume" but starts nothing.
    expect(suggestionsFor("/sum", commands).map((one) => one.name)).toEqual(["resume"]);
  });

  it("offers nothing for a message, or once arguments begin", () => {
    expect(suggestionsFor("hello there", commands)).toEqual([]);
    expect(suggestionsFor("/model gpt-5", commands)).toEqual([]);
    expect(suggestionsFor("/nonsense", commands)).toEqual([]);
  });
});
