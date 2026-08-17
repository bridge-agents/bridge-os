import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemTool } from "./native.js";
import type { SandboxPolicy } from "./sandbox.js";

/**
 * The file tools.
 *
 * Two things are being tested and they pull in opposite directions: an agent
 * has to be able to do real work on real files, and it must not be able to
 * reach somewhere nobody allowed. Every test here is one or the other.
 */
let root: string;
let outside: string;

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  network: "none",
  filesystem: "workspace",
  root,
  ...overrides,
});

const run = (input: Record<string, unknown>, over: Partial<SandboxPolicy> = {}) => {
  const tool = filesystemTool(policy(over));
  return tool.execute(input as Parameters<typeof tool.execute>[0], {
    workspaceId: "ws_test",
    agentId: "agt_test",
    runId: "run_test",
    log: () => undefined,
    checkPermission: () => "allow",
  });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-fs-"));
  outside = mkdtempSync(join(tmpdir(), "bridge-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("reading", () => {
  it("reads a file", async () => {
    writeFileSync(join(root, "notes.md"), "hello");
    expect(await run({ operation: "read", path: "notes.md" })).toMatchObject({
      ok: true,
      output: "hello",
    });
  });

  it("reads a slice of a long file", async () => {
    // A large file should not have to arrive whole to be useful.
    writeFileSync(
      join(root, "big.txt"),
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const result = await run({ operation: "read", path: "big.txt", startLine: 100, lineCount: 3 });
    expect(result.output).toMatchObject({ startLine: 100, totalLines: 500 });
    expect((result.output as { content: string }).content).toBe("line 100\nline 101\nline 102");
  });

  it("lists a directory", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "a");

    const result = await run({ operation: "list", path: "." });
    expect(result.output).toEqual(
      expect.arrayContaining([
        { name: "sub", type: "directory" },
        { name: "a.txt", type: "file" },
      ]),
    );
  });
});

describe("finding", () => {
  beforeEach(() => {
    mkdirSync(join(root, "docs/deep"), { recursive: true });
    writeFileSync(join(root, "docs/one.md"), "alpha\nbeta");
    writeFileSync(join(root, "docs/deep/two.md"), "gamma");
    writeFileSync(join(root, "docs/notes.txt"), "alpha again");
  });

  it("globs across directories", async () => {
    const result = await run({ operation: "glob", path: ".", pattern: "**/*.md" });
    const matches = (result.output as { matches: string[] }).matches;

    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.endsWith("two.md"))).toBe(true);
  });

  it("globs one level with a single star", async () => {
    const result = await run({ operation: "glob", path: "docs", pattern: "*.md" });
    // `*` does not cross a directory boundary, so the nested file is out.
    expect((result.output as { matches: string[] }).matches).toHaveLength(1);
  });

  it("greps file contents and says where", async () => {
    const result = await run({ operation: "grep", path: ".", query: "alpha" });
    const hits = (result.output as { matches: { file: string; line: number }[] }).matches;

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ line: 1 });
  });

  it("greps only the files a pattern selects", async () => {
    const result = await run({ operation: "grep", path: ".", query: "alpha", pattern: "**/*.md" });
    expect((result.output as { matches: unknown[] }).matches).toHaveLength(1);
  });
});

describe("changing", () => {
  it("writes a file and returns it as an artifact", async () => {
    const result = await run({ operation: "write", path: "out/report.md", content: "# Report" });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "out/report.md"), "utf8")).toBe("# Report");
    expect(result.artifacts?.[0]?.name).toBe("report.md");
  });

  it("edits one exact fragment, leaving the rest alone", async () => {
    writeFileSync(join(root, "config.json"), '{\n  "port": 3000,\n  "host": "localhost"\n}');

    await run({
      operation: "edit",
      path: "config.json",
      find: '"port": 3000',
      content: '"port": 8080',
    });

    // The point of edit over write: everything not named is untouched.
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe(
      '{\n  "port": 8080,\n  "host": "localhost"\n}',
    );
  });

  it("refuses an edit whose target appears more than once", async () => {
    writeFileSync(join(root, "dupe.txt"), "value\nvalue");
    const result = await run({ operation: "edit", path: "dupe.txt", find: "value", content: "x" });

    // Ambiguity means it cannot know which one it changed, and an edit in
    // the wrong place is worse than no edit.
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/appears 2 times/);
    expect(readFileSync(join(root, "dupe.txt"), "utf8")).toBe("value\nvalue");
  });

  it("refuses an edit whose target is not there", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const result = await run({ operation: "edit", path: "a.txt", find: "goodbye", content: "x" });

    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
  });

  it("makes directories, moves and deletes", async () => {
    await run({ operation: "mkdir", path: "archive" });
    writeFileSync(join(root, "draft.md"), "draft");

    await run({ operation: "move", path: "draft.md", to: "archive/draft.md" });
    expect(readFileSync(join(root, "archive/draft.md"), "utf8")).toBe("draft");

    expect((await run({ operation: "delete", path: "archive/draft.md" })).ok).toBe(true);
  });
});

describe("the boundary", () => {
  it("refuses to leave the workspace by default", async () => {
    writeFileSync(join(outside, "secret.txt"), "private");
    const result = await run({ operation: "read", path: join(outside, "secret.txt") });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/outside this agent's workspace/);
  });

  it("refuses to climb out with ..", async () => {
    const result = await run({ operation: "read", path: "../../etc/hosts" });
    expect(result.ok).toBe(false);
  });

  it("reaches a directory that was explicitly allowed", async () => {
    writeFileSync(join(outside, "notes.md"), "allowed");

    const result = await run(
      { operation: "read", path: join(outside, "notes.md") },
      { allowedPaths: [outside] },
    );
    expect(result).toMatchObject({ ok: true, output: "allowed" });
  });

  it("still refuses a sibling of an allowed directory", async () => {
    // Prefix matching on strings alone would let "/tmp/x-evil" through for
    // an allowed "/tmp/x".
    const sibling = `${outside}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "no");
    try {
      const result = await run(
        { operation: "read", path: join(sibling, "secret.txt") },
        { allowedPaths: [outside] },
      );
      expect(result.ok).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("goes anywhere when the sandbox is full", async () => {
    writeFileSync(join(outside, "anywhere.txt"), "reachable");
    const result = await run(
      { operation: "read", path: join(outside, "anywhere.txt") },
      { filesystem: "full" },
    );
    expect(result).toMatchObject({ ok: true, output: "reachable" });
  });

  it("has no filesystem at all when the sandbox says none", async () => {
    const result = await run({ operation: "read", path: "anything" }, { filesystem: "none" });
    expect(result.ok).toBe(false);
  });
});

describe("what needs an approval", () => {
  const actionFor = (input: Record<string, unknown>) =>
    filesystemTool(policy()).actionFor?.(
      input as Parameters<NonNullable<ReturnType<typeof filesystemTool>["actionFor"]>>[0],
    );

  it("treats reads and searches inside the workspace as ordinary", () => {
    expect(actionFor({ operation: "read", path: "notes.md" })).toBe("read");
    expect(actionFor({ operation: "grep", path: ".", query: "x" })).toBe("grep");
  });

  it("marks writes as the dangerous actions they are", () => {
    const dangerous = filesystemTool(policy()).actions?.filter((a) => a.dangerous) ?? [];
    expect(dangerous.map((a) => a.name)).toEqual(
      expect.arrayContaining(["write", "edit", "delete", "move"]),
    );
  });

  it("treats anything that might leave the workspace as dangerous", () => {
    // Judged before execution, from the path as written — so an absolute
    // path is suspect even if it would have resolved somewhere allowed.
    expect(actionFor({ operation: "read", path: "/etc/hosts" })).toBe("reach-outside-workspace");
    expect(actionFor({ operation: "read", path: "~/Documents/a.md" })).toBe(
      "reach-outside-workspace",
    );
    expect(actionFor({ operation: "read", path: "../escape" })).toBe("reach-outside-workspace");
    expect(actionFor({ operation: "move", path: "a.md", to: "/tmp/b.md" })).toBe(
      "reach-outside-workspace",
    );
  });
});
