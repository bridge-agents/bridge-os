import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { BridgeTool, ToolResult } from "@bridge/sdk";
import { z } from "zod";
import {
  assertFilesystemAllowed,
  assertNetworkAllowed,
  resolveWithin,
  type SandboxPolicy,
} from "./sandbox.js";

const run = promisify(execFile);

/** Keeps a tool result from blowing out the model's context. */
function truncate(text: string, limit = 20_000): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

function failed(error: unknown): ToolResult {
  return {
    ok: false,
    output: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

const HttpInput = z.object({
  url: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export function httpTool(policy: SandboxPolicy, options: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  const tool: BridgeTool<z.infer<typeof HttpInput>> = {
    name: "http",
    description:
      "Make an HTTP request to a URL and return the response body. Use GET to read; other methods change remote state.",
    inputSchema: HttpInput,
    actions: [{ name: "read" }, { name: "write", dangerous: true }],
    // Anything that is not a GET can change something on the other end.
    actionFor: (input) => (input.method === "GET" || !input.method ? "read" : "write"),
    async execute(input) {
      try {
        const url = await assertNetworkAllowed(policy, input.url);
        const response = await fetchImpl(url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          // A redirect could point at private space after the check passed.
          redirect: "manual",
        });
        const text = await response.text();
        return {
          ok: response.ok,
          output: { status: response.status, body: truncate(text) },
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
  return tool;
}

const FilesystemInput = z.object({
  operation: z.enum(["read", "list", "write", "delete"]),
  path: z.string().min(1),
  content: z.string().optional(),
});

export function filesystemTool(policy: SandboxPolicy) {
  const tool: BridgeTool<z.infer<typeof FilesystemInput>> = {
    name: "filesystem",
    description:
      "Read, list, write or delete files in this agent's workspace. Paths are relative to the workspace root.",
    inputSchema: FilesystemInput,
    actions: [
      { name: "read" },
      { name: "list" },
      { name: "write", dangerous: true },
      { name: "delete", dangerous: true },
    ],
    actionFor: (input) => input.operation,
    async execute(input) {
      try {
        assertFilesystemAllowed(policy);
        const path = await resolveWithin(policy.root, input.path);

        switch (input.operation) {
          case "read":
            return { ok: true, output: truncate(await readFile(path, "utf8")) };
          case "list": {
            const entries = await readdir(path, { withFileTypes: true });
            return {
              ok: true,
              output: entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? "directory" : "file",
              })),
            };
          }
          case "write": {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, input.content ?? "", "utf8");
            const written = await stat(path);
            return { ok: true, output: { path: input.path, bytes: written.size } };
          }
          default:
            await unlink(path);
            return { ok: true, output: { path: input.path, deleted: true } };
        }
      } catch (error) {
        return failed(error);
      }
    },
  };
  return tool;
}

const ShellInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export function shellTool(policy: SandboxPolicy, options: { timeoutMs?: number } = {}) {
  const tool: BridgeTool<z.infer<typeof ShellInput>> = {
    name: "shell",
    description:
      "Run a command in this agent's workspace. Provide the executable and its arguments separately; there is no shell interpretation.",
    inputSchema: ShellInput,
    // Every invocation is dangerous — there is no read-only way to run a command.
    actions: [{ name: "exec", dangerous: true }],
    actionFor: () => "exec",
    async execute(input) {
      try {
        assertFilesystemAllowed(policy);
        await mkdir(policy.root, { recursive: true });

        // execFile, not exec: arguments are passed as a vector, so a command
        // string cannot smuggle in `;` or `&&` to run something else.
        const { stdout, stderr } = await run(input.command, input.args, {
          cwd: policy.root,
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: 1024 * 1024,
          // A minimal environment: the process does not inherit Bridge's own
          // secrets from process.env.
          env: { PATH: process.env.PATH ?? "", HOME: policy.root },
        });
        return { ok: true, output: { stdout: truncate(stdout), stderr: truncate(stderr) } };
      } catch (error) {
        return failed(error);
      }
    },
  };
  return tool;
}

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().max(20).default(5),
});

export interface WebSearchConfig {
  /** Search API endpoint; the query is appended as ?q=. */
  endpoint?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Web search over a configurable JSON search API (Brave, Serper, Tavily, or
 * anything returning a results array). It is a first-class tool with a real
 * schema either way — unconfigured, it fails with an instruction rather than
 * pretending to search.
 */
export function webSearchTool(policy: SandboxPolicy, config: WebSearchConfig = {}) {
  const fetchImpl = config.fetchImpl ?? fetch;

  const tool: BridgeTool<z.infer<typeof SearchInput>> = {
    name: "web-search",
    description: "Search the web and return result titles, URLs and snippets.",
    inputSchema: SearchInput,
    actions: [{ name: "search" }],
    actionFor: () => "search",
    async execute(input) {
      if (!config.endpoint) {
        return {
          ok: false,
          output: null,
          error:
            "web search is not configured for this workspace; set a search endpoint in provider settings",
        };
      }
      try {
        const url = new URL(config.endpoint);
        url.searchParams.set("q", input.query);
        await assertNetworkAllowed(policy, url.toString());

        const response = await fetchImpl(url, {
          headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined,
        });
        if (!response.ok) {
          return { ok: false, output: null, error: `search failed (${response.status})` };
        }

        const body = (await response.json()) as {
          results?: { title?: string; url?: string; description?: string; snippet?: string }[];
        };
        return {
          ok: true,
          output: (body.results ?? []).slice(0, input.limit).map((result) => ({
            title: result.title,
            url: result.url,
            snippet: result.description ?? result.snippet,
          })),
        };
      } catch (error) {
        return failed(error);
      }
    },
  };
  return tool;
}

/** The native tools every workspace gets, bound to one agent's sandbox. */
export function nativeTools(
  policy: SandboxPolicy,
  config: { search?: WebSearchConfig; fetchImpl?: typeof fetch } = {},
): BridgeTool[] {
  return [
    httpTool(policy, { fetchImpl: config.fetchImpl }) as BridgeTool,
    filesystemTool(policy) as BridgeTool,
    shellTool(policy) as BridgeTool,
    webSearchTool(policy, { ...config.search, fetchImpl: config.search?.fetchImpl }) as BridgeTool,
  ];
}
