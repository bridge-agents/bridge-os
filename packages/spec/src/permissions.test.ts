import { describe, expect, it } from "vitest";
import { evaluatePermission, type PermissionPolicy } from "./permissions.js";

const policy: PermissionPolicy = {
  default: "ask",
  rules: [
    { resource: "tool:gmail", actions: ["read"], effect: "allow" },
    { resource: "tool:gmail", actions: ["send"], effect: "ask" },
    { resource: "tool:shell", actions: "*", effect: "deny" },
    { resource: "tool:github*", actions: ["read"], effect: "allow" },
  ],
};

describe("evaluatePermission", () => {
  it.each([
    ["tool:gmail", "read", "allow"],
    ["tool:gmail", "send", "ask"],
    ["tool:gmail", "delete", "ask"], // no rule matches action → default
    ["tool:shell", "exec", "deny"],
    ["tool:github-repos", "read", "allow"], // prefix glob
    ["tool:github-repos", "write", "ask"],
    ["tool:unknown", "anything", "ask"], // default
  ] as const)("%s %s → %s", (resource, action, expected) => {
    expect(evaluatePermission(policy, resource, action)).toBe(expected);
  });

  it("first matching rule wins", () => {
    const p: PermissionPolicy = {
      default: "deny",
      rules: [
        { resource: "tool:x", actions: "*", effect: "allow" },
        { resource: "tool:x", actions: "*", effect: "deny" },
      ],
    };
    expect(evaluatePermission(p, "tool:x", "run")).toBe("allow");
  });

  it("read access never implies write access", () => {
    const readOnly: PermissionPolicy = {
      default: "ask",
      rules: [{ resource: "tool:gmail", actions: ["read"], effect: "allow" }],
    };
    expect(evaluatePermission(readOnly, "tool:gmail", "send")).not.toBe("allow");
  });
});
