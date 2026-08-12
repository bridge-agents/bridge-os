import { type ChildProcess, spawn } from "node:child_process";
import { BridgeError } from "@bridge/core";
import type { BridgeTool, ToolResult } from "@bridge/sdk";
import { z } from "zod";

/**
 * Minimal MCP client (JSON-RPC 2.0) over the two standard transports.
 *
 * MCP servers are surfaced as ordinary {@link BridgeTool}s, so they flow
 * through the same permission checks, approvals and tracing as native tools —
 * MCP is a transport, not a second tool concept (ADR-0007).
 */
export interface McpServerConfig {
  /** Tool-grant name; the server's tools appear as `<name>.<toolName>`. */
  name: string;
  /** stdio: command + args. http: url. */
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  /** Treat these of the server's tools as destructive. */
  dangerousTools?: string[];
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Newline-delimited JSON-RPC over a child process's stdio. */
export class StdioTransport implements McpTransport {
  private child?: ChildProcess;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly config: { command: string; args?: string[]; cwd?: string }) {}

  private start(): ChildProcess {
    if (this.child) return this.child;

    const child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (message.id === undefined) continue; // notification
          const waiting = this.pending.get(message.id);
          if (!waiting) continue;
          this.pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message));
          else waiting.resolve(message.result);
        } catch {
          // Servers sometimes log to stdout; ignore anything that isn't JSON-RPC.
        }
      }
    });

    child.on("exit", (code) => {
      for (const [, waiting] of this.pending) {
        waiting.reject(new Error(`MCP server exited (code ${code})`));
      }
      this.pending.clear();
      this.child = undefined;
    });

    this.child = child;
    return child;
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.start();
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async close(): Promise<void> {
    this.child?.kill();
    this.child = undefined;
  }
}

/** JSON-RPC over HTTP POST. */
export class HttpTransport implements McpTransport {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    if (!response.ok) throw new Error(`MCP server returned ${response.status}`);

    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }

  async close(): Promise<void> {
    /* stateless */
  }
}

export class McpClient {
  private initialized = false;

  constructor(private readonly transport: McpTransport) {}

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.transport.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bridge", version: "0.4.0" },
    });
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    await this.initialize();
    const result = (await this.transport.request("tools/list")) as {
      tools?: McpToolDescriptor[];
    };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.initialize();
    const result = (await this.transport.request("tools/call", {
      name,
      arguments: args,
    })) as { content?: { type: string; text?: string }[]; isError?: boolean };

    const text = (result?.content ?? [])
      .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
      .join("\n");

    return { ok: !result?.isError, output: text, error: result?.isError ? text : undefined };
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

export function createTransport(config: McpServerConfig): McpTransport {
  if (config.command) {
    return new StdioTransport({ command: config.command, args: config.args });
  }
  if (config.url) return new HttpTransport(config.url, config.headers);
  throw new BridgeError(
    "validation_failed",
    `MCP server "${config.name}" needs either a command (stdio) or a url (http)`,
  );
}

/**
 * Discover an MCP server's tools and wrap each one as a Bridge tool named
 * `<grant>.<tool>`, so permissions can be written per remote tool.
 */
export async function loadMcpTools(
  config: McpServerConfig,
  client = new McpClient(createTransport(config)),
): Promise<BridgeTool[]> {
  const descriptors = await client.listTools();
  const dangerous = new Set(config.dangerousTools ?? []);

  return descriptors.map((descriptor) => {
    const tool: BridgeTool<Record<string, unknown>> = {
      name: `${config.name}.${descriptor.name}`,
      description: descriptor.description ?? `${descriptor.name} (via ${config.name})`,
      // The server owns its schema; Bridge passes arguments through and lets
      // the server reject what it does not like.
      inputSchema: z.record(z.string(), z.unknown()),
      jsonSchema: descriptor.inputSchema ?? { type: "object", properties: {} },
      actions: [{ name: "call", dangerous: dangerous.has(descriptor.name) }],
      actionFor: () => "call",
      execute: (input) => client.callTool(descriptor.name, input),
    };
    return tool as BridgeTool;
  });
}
