import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@bridge/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filesystemTool, httpTool, imageTool, shellTool, webSearchTool } from "./native.js";
import { assertGrantsSupported, ToolRegistry } from "./registry.js";
import { assertNetworkAllowed, resolveWithin, type SandboxPolicy } from "./sandbox.js";

let root: string;
let outside: string;

const ctx = {
  workspaceId: "ws_1",
  agentId: "agt_1",
  runId: "run_1",
  log: () => {},
  checkPermission: () => "allow" as const,
} satisfies ToolContext;

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  network: "restricted",
  filesystem: "workspace",
  root,
  ...overrides,
});

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "bridge-tools-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await filesystemTool(policy()).execute(
    { operation: "write", path: "seed.txt", content: "" },
    ctx,
  );
  await writeFile(join(base, "secret.txt"), "top secret", "utf8").catch(() => {});
});

afterAll(() => {
  /* temp dir is cleaned up by the OS */
});

describe("filesystem sandbox", () => {
  it("writes, reads, lists and deletes inside the workspace", async () => {
    const tool = filesystemTool(policy());

    expect(
      (await tool.execute({ operation: "write", path: "notes/a.txt", content: "hello" }, ctx)).ok,
    ).toBe(true);
    const read = await tool.execute({ operation: "read", path: "notes/a.txt" }, ctx);
    expect(read.output).toBe("hello");

    const listed = await tool.execute({ operation: "list", path: "notes" }, ctx);
    expect(listed.output).toEqual([{ name: "a.txt", type: "file" }]);

    expect((await tool.execute({ operation: "delete", path: "notes/a.txt" }, ctx)).ok).toBe(true);
    expect((await tool.execute({ operation: "read", path: "notes/a.txt" }, ctx)).ok).toBe(false);
  });

  it("refuses to escape the workspace with ..", async () => {
    const result = await filesystemTool(policy()).execute(
      { operation: "read", path: "../secret.txt" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside this agent's workspace/);
  });

  it("refuses an absolute path outside the workspace", async () => {
    const result = await filesystemTool(policy()).execute(
      { operation: "read", path: "/etc/hosts" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside this agent's workspace/);
  });

  it("refuses a symlink that points outside the workspace", async () => {
    await writeFile(join(outside, "..", "target.txt"), "leaked", "utf8").catch(async () => {
      await filesystemTool(policy()).execute(
        { operation: "write", path: "placeholder", content: "" },
        ctx,
      );
    });
    const linkPath = join(root, "escape-link");
    await symlink(join(root, "..", "secret.txt"), linkPath).catch(() => {});

    const result = await filesystemTool(policy()).execute(
      { operation: "read", path: "escape-link" },
      ctx,
    );
    // Resolved before the check, so the link cannot be used as a way out.
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside this agent's workspace/);
  });

  it("refuses everything when the agent has no filesystem access", async () => {
    const result = await filesystemTool(policy({ filesystem: "none" })).execute(
      { operation: "read", path: "seed.txt" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no filesystem access/);
  });

  it("classifies operations into the right permission actions", () => {
    const tool = filesystemTool(policy());
    expect(tool.actionFor?.({ operation: "read", path: "x" })).toBe("read");
    expect(tool.actionFor?.({ operation: "delete", path: "x" })).toBe("delete");
    // Only the destructive ones are flagged dangerous.
    expect(tool.actions.filter((action) => action.dangerous).map((a) => a.name)).toEqual([
      "write",
      "edit",
      "move",
      "delete",
      // Any path that might leave the workspace, whatever the verb.
      "reach-outside-workspace",
    ]);
  });
});

describe("network sandbox", () => {
  it("blocks loopback and private addresses on restricted", async () => {
    for (const url of ["http://127.0.0.1/x", "http://localhost:8080", "http://10.0.0.1/"]) {
      await expect(assertNetworkAllowed(policy(), url)).rejects.toThrow(/private address|resolve/);
    }
  });

  it("blocks the cloud metadata endpoint", async () => {
    await expect(
      assertNetworkAllowed(policy(), "http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow();
  });

  it("refuses non-http protocols", async () => {
    await expect(assertNetworkAllowed(policy(), "file:///etc/passwd")).rejects.toThrow(
      /unsupported protocol/,
    );
  });

  it("refuses everything when the agent has no network access", async () => {
    await expect(
      assertNetworkAllowed(policy({ network: "none" }), "https://example.com"),
    ).rejects.toThrow(/no network access/);
  });

  it("allows anything on full, including local endpoints", async () => {
    await expect(
      assertNetworkAllowed(policy({ network: "full" }), "http://localhost:11434/v1"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("allows an explicitly permitted host on restricted", async () => {
    await expect(
      assertNetworkAllowed(policy(), "http://localhost:11434/v1", { allowHosts: ["localhost"] }),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("http tool", () => {
  it("treats GET as read and other methods as write", () => {
    const tool = httpTool(policy());
    expect(tool.actionFor?.({ url: "https://x", method: "GET" })).toBe("read");
    expect(tool.actionFor?.({ url: "https://x", method: "DELETE" })).toBe("write");
    expect(tool.actions.find((action) => action.name === "write")?.dangerous).toBe(true);
  });

  it("reports a blocked request as a failed result rather than throwing", async () => {
    const result = await httpTool(policy()).execute(
      { url: "http://127.0.0.1/", method: "GET" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("does not follow redirects", async () => {
    let seenRedirect: string | undefined;
    const tool = httpTool(policy({ network: "full" }), {
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seenRedirect = init?.redirect;
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await tool.execute({ url: "https://example.com", method: "GET" }, ctx);
    expect(seenRedirect).toBe("manual");
  });
});

describe("shell tool", () => {
  it("runs a command in the workspace", async () => {
    const result = await shellTool(policy()).execute({ command: "echo", args: ["hi"] }, ctx);
    expect(result.ok).toBe(true);
    expect((result.output as { stdout: string }).stdout.trim()).toBe("hi");
  });

  it("passes arguments as a vector, so shell operators are not interpreted", async () => {
    // If this went through a shell, the `;` would run a second command.
    const result = await shellTool(policy()).execute(
      { command: "echo", args: ["a; echo pwned"] },
      ctx,
    );
    expect((result.output as { stdout: string }).stdout.trim()).toBe("a; echo pwned");
  });

  it("is always dangerous and refuses without filesystem access", async () => {
    expect(shellTool(policy()).actions[0]?.dangerous).toBe(true);
    const result = await shellTool(policy({ filesystem: "none" })).execute(
      { command: "echo", args: [] },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});

describe("web search tool", () => {
  it("says it is unconfigured instead of pretending to search", async () => {
    const result = await webSearchTool(policy()).execute({ query: "bridges", limit: 5 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/);
  });

  it("normalizes results from a configured endpoint", async () => {
    const tool = webSearchTool(policy({ network: "full" }), {
      endpoint: "https://search.example/api",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "Bridge", url: "https://b", description: "a span" }],
          }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    const result = await tool.execute({ query: "bridges", limit: 5 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toEqual([{ title: "Bridge", url: "https://b", snippet: "a span" }]);
  });
});

describe("image tool", () => {
  const png = Buffer.from("not really a png").toString("base64");

  it("says it needs a provider instead of failing silently", async () => {
    const result = await imageTool().execute({ prompt: "a bridge at dusk" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connect one in Providers/);
  });

  it("returns the picture as an artifact, which is what puts it in the chat", async () => {
    let sent: unknown;
    const tool = imageTool({
      endpoint: "https://api.openai.example/v1",
      apiKey: "k",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ data: [{ b64_json: png }] }), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const result = await tool.execute({ prompt: "a bridge at dusk", size: "1024x1024" }, ctx);
    expect(result.ok).toBe(true);
    expect(sent).toMatchObject({ prompt: "a bridge at dusk", size: "1024x1024", n: 1 });
    expect(result.artifacts).toEqual([
      { name: "image-1.png", mimeType: "image/png", dataBase64: png },
    ]);
  });

  it("fetches the bytes when the provider hands back a URL", async () => {
    const tool = imageTool({
      endpoint: "https://api.openai.example/v1",
      apiKey: "k",
      fetchImpl: (async (url: string | URL) =>
        String(url).includes("/images/generations")
          ? new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.png" }] }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(Buffer.from(png, "base64"), {
              headers: { "content-type": "image/png" },
            })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ prompt: "a bridge" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.artifacts?.[0]).toMatchObject({ name: "image-1.png", dataBase64: png });
  });

  it("reports why the provider refused", async () => {
    const tool = imageTool({
      endpoint: "https://api.openai.example/v1",
      apiKey: "k",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "billing hard limit reached" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const result = await tool.execute({ prompt: "a bridge" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/billing hard limit reached/);
  });
});

describe("registry", () => {
  it("resolves grants, including MCP prefixes", () => {
    const mcpStyle = httpTool(policy());
    const registry = new ToolRegistry([
      filesystemTool(policy()) as never,
      // Stands in for a tool discovered from an MCP server.
      Object.assign(Object.create(Object.getPrototypeOf(mcpStyle) ?? {}), mcpStyle, {
        name: "github.create_issue",
      }) as never,
    ]);

    expect(registry.forGrants(["filesystem"]).map((tool) => tool.name)).toEqual(["filesystem"]);
    expect(registry.forGrants(["github"]).map((tool) => tool.name)).toEqual([
      "github.create_issue",
    ]);
    expect(registry.forGrants(["nope"])).toEqual([]);
  });

  it("rejects grants nothing can execute", () => {
    expect(() =>
      assertGrantsSupported([
        { name: "filesystem", kind: "native", config: {} },
        { name: "telepathy", kind: "native", config: {} },
      ]),
    ).toThrow(/no implementation/);

    expect(() =>
      assertGrantsSupported([{ name: "github", kind: "mcp", config: {} }]),
    ).not.toThrow();
  });
});

describe("resolveWithin", () => {
  it("returns a canonical path inside the root", async () => {
    const resolved = await resolveWithin(root, "nested/file.txt");
    // Compared against the canonical root: on macOS /var is a symlink to
    // /private/var, and resolving is exactly what makes the check sound.
    const canonicalRoot = await realpath(root);
    expect(resolved.startsWith(canonicalRoot)).toBe(true);
    expect(resolved.endsWith("nested/file.txt")).toBe(true);
  });

  it("rejects traversal even when it dips inside first", async () => {
    await expect(resolveWithin(root, "nested/../../secret.txt")).rejects.toThrow(
      /outside this agent's workspace/,
    );
  });
});
