import { fileURLToPath } from "node:url";
import type { ToolContext } from "@bridge/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { HttpTransport, loadMcpTools, McpClient, StdioTransport } from "./mcp.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/mcp-server.mjs", import.meta.url));

const ctx = {
  workspaceId: "ws_1",
  agentId: "agt_1",
  runId: "run_1",
  log: () => {},
  checkPermission: () => "allow" as const,
} satisfies ToolContext;

const clients: McpClient[] = [];
function stdioClient(): McpClient {
  const client = new McpClient(new StdioTransport({ command: process.execPath, args: [FIXTURE] }));
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("MCP over stdio", () => {
  it("initializes and lists the server's tools", async () => {
    const tools = await stdioClient().listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "explode"]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("calls a tool and returns its text content", async () => {
    const result = await stdioClient().callTool("echo", { message: "hello" });
    expect(result).toEqual({ ok: true, output: "echo: hello", error: undefined });
  });

  it("surfaces a server-reported error as a failed result", async () => {
    const result = await stdioClient().callTool("explode", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });

  it("preserves generated image blocks as artifacts", async () => {
    const client = new McpClient({
      async request(method) {
        if (method === "initialize") return {};
        return {
          content: [
            { type: "text", text: "Created the image." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        };
      },
      async close() {},
    });

    const result = await client.callTool("generate", {});
    expect(result).toMatchObject({
      ok: true,
      output: "Created the image.\n[Generated image attached]",
      artifacts: [
        {
          name: "generated-image-2.png",
          mimeType: "image/png",
          dataBase64: "aGVsbG8=",
        },
      ],
    });
  });
});

describe("MCP tools as Bridge tools", () => {
  it("wraps each remote tool, namespaced by its grant", async () => {
    const tools = await loadMcpTools({ name: "fixture" }, stdioClient());

    expect(tools.map((tool) => tool.name)).toEqual(["fixture.echo", "fixture.explode"]);
    // The server's own schema is carried through so models see real parameters.
    expect(tools[0]?.jsonSchema).toMatchObject({
      properties: { message: { type: "string" } },
    });
  });

  it("executes through the Bridge tool interface", async () => {
    const [echo] = await loadMcpTools({ name: "fixture" }, stdioClient());
    const result = await echo?.execute({ message: "via bridge" }, ctx);
    expect(result).toMatchObject({ ok: true, output: "echo: via bridge" });
  });

  it("marks configured tools dangerous so they need approval", async () => {
    const tools = await loadMcpTools(
      { name: "fixture", dangerousTools: ["explode"] },
      stdioClient(),
    );

    expect(tools.find((tool) => tool.name === "fixture.echo")?.actions[0]?.dangerous).toBe(false);
    expect(tools.find((tool) => tool.name === "fixture.explode")?.actions[0]?.dangerous).toBe(true);
  });
});

describe("MCP over HTTP", () => {
  it("speaks JSON-RPC to an HTTP endpoint", async () => {
    const requests: unknown[] = [];
    const transport = new HttpTransport(
      "https://mcp.example/rpc",
      { authorization: "Bearer t" },
      (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const result =
          body.method === "tools/list"
            ? { tools: [{ name: "remote", description: "A remote tool." }] }
            : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    );

    const tools = await new McpClient(transport).listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["remote"]);
    // Initialize is sent before anything else, exactly once.
    expect((requests[0] as { method: string }).method).toBe("initialize");
    expect((requests[1] as { method: string }).method).toBe("tools/list");
  });

  it("raises the server's error message", async () => {
    const transport = new HttpTransport(
      "https://mcp.example/rpc",
      {},
      (async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "nope" } }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    );

    await expect(new McpClient(transport).listTools()).rejects.toThrow(/nope/);
  });
});
