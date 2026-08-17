import { describe, expect, it } from "vitest";
import { commands } from "./commands.js";
import {
  availableCommands,
  findCommand,
  parseCommand,
  searchCommands,
  tokenize,
} from "./registry.js";
import { type CommandContext, CommandError } from "./types.js";

/**
 * Parsing and dispatch.
 *
 * These are the shared half of "type it in a terminal or type it in chat",
 * so getting them wrong breaks both surfaces at once.
 */
describe("finding a command", () => {
  it("finds one by name", () => {
    expect(findCommand("status")?.name).toBe("status");
  });

  it("ignores a leading slash, which is how chat sends it", () => {
    expect(findCommand("/status")?.name).toBe("status");
  });

  it("does not mistake a longer word for a command", () => {
    expect(findCommand("statuses")).toBeUndefined();
  });

  it("prefers the most specific name", () => {
    // "runs <agent>" and "run <agent> <task>" both start with "run"; typing
    // "runs helper" must not resolve to "run" with an agent called "s".
    expect(findCommand("runs helper")?.name).toBe("runs");
    expect(findCommand("run helper do a thing")?.name).toBe("run");
  });
});

describe("parsing arguments", () => {
  it("reads positional arguments", () => {
    const { command, args } = parseCommand("approve apr_123");
    expect(command.name).toBe("approve");
    expect(args.approval).toBe("apr_123");
  });

  it("gives the last argument everything left over", () => {
    // Otherwise every task would have to be quoted, which nobody would do.
    const { args } = parseCommand("run helper summarise my week and email it");
    expect(args.agent).toBe("helper");
    expect(args.task).toBe("summarise my week and email it");
  });

  it("keeps quoted words together", () => {
    expect(tokenize('deploy "my agent" now')).toEqual(["deploy", "my agent", "now"]);
  });

  it("refuses a command missing something it needs, and says what", () => {
    expect(() => parseCommand("approve")).toThrow(/approval/);
  });

  it("allows an optional argument to be left out", () => {
    const { args } = parseCommand("deny apr_1");
    expect(args.approval).toBe("apr_1");
    expect(args.reason).toBeUndefined();
  });

  it("suggests help for something that is not a command", () => {
    expect(() => parseCommand("/frobnicate")).toThrow(CommandError);
    expect(() => parseCommand("/frobnicate")).toThrow(/\/help/);
  });
});

describe("what each surface offers", () => {
  it("hides terminal-only commands from the web", () => {
    const web = availableCommands("web").map((command) => command.name);
    expect(web.every((name) => !commands.find((c) => c.name === name)?.cliOnly)).toBe(true);
  });

  it("ranks an exact name above a description match", () => {
    const results = searchCommands("run");
    expect(results[0]?.name).toBe("run");
  });

  it("finds a command by a word inside its name", () => {
    expect(searchCommands("list").map((command) => command.name)).toContain("agents");
  });

  it("returns everything for an empty query, which is the palette's first frame", () => {
    expect(searchCommands("")).toHaveLength(availableCommands("web").length);
  });
});

describe("commands themselves", () => {
  it("all declare a summary and a group", () => {
    for (const command of commands) {
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.group).toBeTruthy();
    }
  });

  it("puts required arguments before optional ones", () => {
    // Otherwise positional parsing silently assigns the wrong values.
    for (const command of commands) {
      const required = (command.args ?? []).map((arg) => Boolean(arg.required));
      expect(required).toEqual([...required].sort((a, b) => Number(b) - Number(a)));
    }
  });

  it("only ever declares the last argument as rest", () => {
    for (const command of commands) {
      const args = command.args ?? [];
      expect(args.slice(0, -1).some((arg) => arg.rest)).toBe(false);
    }
  });

  it("talks to Bridge only through versioned endpoints", async () => {
    // The invariant that keeps one implementation honest: if a command ever
    // needs something else, that is a missing endpoint, not a shortcut.
    const paths: string[] = [];
    const ctx: CommandContext = {
      workspaceId: "ws_1",
      request: async <T>(path: string) => {
        paths.push(path);
        return {
          agents: [],
          approvals: [],
          automations: [],
          providers: [],
          runs: [],
          data: { value: 0 },
          status: "ok",
          version: "0.0.0",
          checks: { db: "up" },
        } as T;
      },
    };

    for (const command of commands.filter((c) => !(c.args ?? []).some((a) => a.required))) {
      await command.run(ctx, {});
    }
    expect(paths.every((path) => path.startsWith("/v1/") || path === "/health")).toBe(true);
  });
});
