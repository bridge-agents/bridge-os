import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { BridgeError } from "@bridge/core";
import type { BridgeTool, ToolArtifact, ToolResult } from "@bridge/sdk";
import { z } from "zod";
import {
  assertFilesystemAllowed,
  assertNetworkAllowed,
  resolvePath,
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
  operation: z.enum(["read", "list", "write", "edit", "delete", "mkdir", "move", "glob", "grep"]),
  path: z.string().min(1),
  /** New contents for `write`; the replacement text for `edit`. */
  content: z.string().optional(),
  /**
   * How to read `content` on `write`. Base64 is how a picture gets written at
   * all — text is the only thing a model can emit, so binary files have to
   * arrive encoded or not at all.
   */
  encoding: z.enum(["utf8", "base64"]).optional(),
  /** The exact text `edit` replaces. Must appear once. */
  find: z.string().optional(),
  /** Destination for `move`. */
  to: z.string().optional(),
  /** Filename pattern for `glob`, e.g. "**\/*.md". */
  pattern: z.string().optional(),
  /** Regular expression for `grep`. */
  query: z.string().optional(),
  /** Read a slice of a long file rather than all of it. */
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(5000).optional(),
});

/**
 * Files.
 *
 * The operations are the ones you need to actually work rather than just
 * fetch: `edit` replaces an exact fragment instead of rewriting a whole file
 * (so an agent cannot silently drop the parts it did not think about),
 * `glob` and `grep` find things without shelling out, and `read` takes a
 * line range so a large file does not have to arrive whole.
 *
 * Where it may go is the sandbox's business, not this tool's — see
 * `resolvePath`. What this tool decides is which operations are dangerous,
 * and it treats anything reaching outside the agent's own workspace as
 * dangerous regardless of the verb: reading your documents is not the same
 * act as reading a scratch file the agent wrote itself.
 */
export function filesystemTool(policy: SandboxPolicy) {
  const tool: BridgeTool<z.infer<typeof FilesystemInput>> = {
    name: "filesystem",
    description:
      "Work with files. read, list, glob, grep to look; write, edit, mkdir, move, delete to change. " +
      "Paths may be relative to the agent's workspace, absolute, or start with ~. " +
      'To write an image or any binary file, base64-encode it and set encoding to "base64". ' +
      "Files written are shown to the user with your reply.",
    inputSchema: FilesystemInput,
    actions: [
      { name: "read" },
      { name: "list" },
      { name: "glob" },
      { name: "grep" },
      { name: "mkdir" },
      { name: "write", dangerous: true },
      { name: "edit", dangerous: true },
      { name: "move", dangerous: true },
      { name: "delete", dangerous: true },
      // Anything outside the agent's own directory, whatever the verb.
      { name: "reach-outside-workspace", dangerous: true },
    ],
    /**
     * Decided *before* execution, so it can only judge the path as written.
     * Anything not plainly relative might leave the workspace, and is
     * treated as if it does — over-approximating here costs an approval
     * prompt, while under-approximating costs you your files.
     */
    actionFor: (input) =>
      leavesWorkspace(input.path) || (input.to !== undefined && leavesWorkspace(input.to))
        ? "reach-outside-workspace"
        : input.operation,
    async execute(input) {
      try {
        const target = await resolvePath(policy, input.path);
        return await runFileOperation(policy, input, target);
      } catch (error) {
        return failed(error);
      }
    },
  };
  return tool;
}

async function runFileOperation(
  policy: SandboxPolicy,
  input: z.infer<typeof FilesystemInput>,
  target: { path: string; scope: string },
): Promise<ToolResult> {
  const path = target.path;

  switch (input.operation) {
    case "read": {
      const text = await readFile(path, "utf8");
      if (!input.startLine && !input.lineCount) return { ok: true, output: truncate(text) };
      const lines = text.split("\n");
      const from = (input.startLine ?? 1) - 1;
      const slice = lines.slice(from, from + (input.lineCount ?? 200));
      return {
        ok: true,
        output: {
          startLine: from + 1,
          totalLines: lines.length,
          content: truncate(slice.join("\n")),
        },
      };
    }

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

    case "glob": {
      const matches: string[] = [];
      for await (const found of walk(path, 6)) {
        if (matchesGlob(found.slice(path.length + 1), input.pattern ?? "*")) matches.push(found);
        if (matches.length >= 500) break;
      }
      return { ok: true, output: { matches, truncated: matches.length >= 500 } };
    }

    case "grep": {
      if (!input.query) throw new BridgeError("validation_failed", "grep needs a query");
      const expression = new RegExp(input.query, "i");
      const hits: { file: string; line: number; text: string }[] = [];
      for await (const file of walk(path, 6)) {
        if (input.pattern && !matchesGlob(file.slice(path.length + 1), input.pattern)) continue;
        const content = await readFile(file, "utf8").catch(() => undefined);
        // Binary and unreadable files are skipped, not reported as errors.
        if (content === undefined || content.includes("\uFFFD")) continue;
        content.split("\n").forEach((line, index) => {
          if (hits.length < 200 && expression.test(line)) {
            hits.push({ file, line: index + 1, text: line.slice(0, 300) });
          }
        });
        if (hits.length >= 200) break;
      }
      return { ok: true, output: { matches: hits, truncated: hits.length >= 200 } };
    }

    case "mkdir": {
      await mkdir(path, { recursive: true });
      return { ok: true, output: { path: input.path, created: true } };
    }

    case "write": {
      await mkdir(dirname(path), { recursive: true });
      // A Buffer writes bytes; a string writes UTF-8, which is the default.
      await writeFile(
        path,
        input.encoding === "base64"
          ? Buffer.from(input.content ?? "", "base64")
          : (input.content ?? ""),
      );
      const written = await stat(path);
      return {
        ok: true,
        output: { path: input.path, bytes: written.size },
        artifacts: [{ name: basename(path), sourcePath: path }],
      };
    }

    case "edit": {
      if (input.find === undefined) {
        throw new BridgeError("validation_failed", 'edit needs the text to replace in "find"');
      }
      const before = await readFile(path, "utf8");
      const occurrences = before.split(input.find).length - 1;
      /**
       * Exactly once, or refuse. Zero means the file is not what the model
       * thinks it is; more than one means it cannot know which it changed —
       * and an edit applied to the wrong place is worse than no edit.
       */
      if (occurrences === 0) {
        throw new BridgeError("validation_failed", `that text does not appear in ${input.path}`);
      }
      if (occurrences > 1) {
        throw new BridgeError(
          "validation_failed",
          `that text appears ${occurrences} times in ${input.path}; include enough context to make it unique`,
        );
      }
      const after = before.replace(input.find, input.content ?? "");
      await writeFile(path, after, "utf8");
      return {
        ok: true,
        output: { path: input.path, replaced: 1, bytes: Buffer.byteLength(after) },
        artifacts: [{ name: basename(path), sourcePath: path }],
      };
    }

    case "move": {
      if (!input.to) throw new BridgeError("validation_failed", 'move needs a destination in "to"');
      const destination = await resolvePath(policy, input.to);
      await mkdir(dirname(destination.path), { recursive: true });
      await rename(path, destination.path);
      return { ok: true, output: { from: input.path, to: input.to } };
    }

    default: {
      await rm(path, { recursive: true, force: false });
      return { ok: true, output: { path: input.path, deleted: true } };
    }
  }
}

/** Absolute, home-relative, or climbing out with `..` — all might not be ours. */
function leavesWorkspace(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.split(/[\\/]/).includes("..")
  );
}

/** Depth-limited file walk; skips the directories nobody means to search. */
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__"]);

async function* walk(root: string, depth: number): AsyncGenerator<string> {
  if (depth < 0) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    if (SKIP.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full, depth - 1);
    else yield full;
  }
}

/** `**` crosses directories, `*` does not, `?` is one character. */
function matchesGlob(relative: string, pattern: string): boolean {
  // Two-step so `**` is not eaten by the `*` rule: the sentinels are strings
  // no glob can contain, swapped back for their patterns at the end.
  const GLOBSTAR_DIR = "\uE000";
  const GLOBSTAR = "\uE001";
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, GLOBSTAR_DIR)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(GLOBSTAR_DIR, "(?:.*/)?")
    .replaceAll(GLOBSTAR, ".*");
  return new RegExp(`^${escaped}$`).test(relative);
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
  provider?: "brave" | "custom";
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
        if (config.provider === "brave") url.searchParams.set("count", String(input.limit));
        await assertNetworkAllowed(policy, url.toString());

        const response = await fetchImpl(url, {
          headers: config.apiKey
            ? config.provider === "brave"
              ? { accept: "application/json", "x-subscription-token": config.apiKey }
              : { authorization: `Bearer ${config.apiKey}` }
            : undefined,
        });
        if (!response.ok) {
          return { ok: false, output: null, error: `search failed (${response.status})` };
        }

        const body = (await response.json()) as {
          results?: { title?: string; url?: string; description?: string; snippet?: string }[];
          web?: {
            results?: { title?: string; url?: string; description?: string; snippet?: string }[];
          };
        };
        const results = config.provider === "brave" ? body.web?.results : body.results;
        return {
          ok: true,
          output: (results ?? []).slice(0, input.limit).map((result) => ({
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

const ImageInput = z.object({
  prompt: z.string().min(1),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
});

export interface ImageConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  endpoint?: string;
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Make a picture.
 *
 * The bytes come back as an artifact rather than a file path, which is what
 * puts the image in the conversation: the run records artifacts as
 * attachments on its reply, and the chat renders an attachment whose type is
 * an image inline. A model cannot draw by talking, so without this tool an
 * agent asked for a picture can only describe one.
 */
/**
 * No sandbox check here, unlike every other tool that reaches the network.
 * The model does not choose this URL — the user did, in Providers, and the
 * only other address touched is whatever that same provider hands back. So
 * there is no address a prompt can point this at, and gating it would mean
 * an agent with no network access cannot draw even though Bridge is the one
 * making the call.
 */
export function imageTool(config: ImageConfig = {}) {
  const fetchImpl = config.fetchImpl ?? fetch;

  const tool: BridgeTool<z.infer<typeof ImageInput>> = {
    name: "image",
    description:
      "Generate an image from a description. The image is attached to your reply and shown to the user, " +
      "so describe what you made rather than pasting any data.",
    inputSchema: ImageInput,
    actions: [{ name: "generate" }],
    actionFor: () => "generate",
    async execute(input) {
      if (!config.endpoint || !config.apiKey) {
        return {
          ok: false,
          output: null,
          error:
            "image generation needs a connected provider that supports it (OpenAI) — connect one in Providers",
        };
      }
      try {
        const url = `${config.endpoint.replace(/\/+$/, "")}/images/generations`;
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model ?? "gpt-image-1",
            prompt: input.prompt,
            n: 1,
            ...(input.size ? { size: input.size } : {}),
          }),
        });

        const body = (await response.json().catch(() => ({}))) as {
          data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
          error?: { message?: string };
        };
        if (!response.ok) {
          return {
            ok: false,
            output: null,
            error: `image generation failed (${response.status}): ${body.error?.message ?? "no reason given"}`,
          };
        }

        // Some endpoints hand back a URL instead of bytes; fetch it either way.
        const artifacts: ToolArtifact[] = [];
        for (const [index, image] of (body.data ?? []).entries()) {
          const name = `image-${index + 1}.png`;
          if (image.b64_json) {
            artifacts.push({ name, mimeType: "image/png", dataBase64: image.b64_json });
          } else if (image.url) {
            const bytes = await fetchImpl(image.url);
            if (!bytes.ok) continue;
            artifacts.push({
              name,
              mimeType: bytes.headers.get("content-type") ?? "image/png",
              dataBase64: Buffer.from(await bytes.arrayBuffer()).toString("base64"),
            });
          }
        }
        if (artifacts.length === 0) {
          return { ok: false, output: null, error: "the provider returned no image" };
        }

        return {
          ok: true,
          output: {
            created: artifacts.map((artifact) => artifact.name),
            note: "The image is attached to your reply; the user can already see it.",
          },
          artifacts,
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
  config: {
    search?: WebSearchConfig;
    image?: ImageConfig;
    fetchImpl?: typeof fetch;
  } = {},
): BridgeTool[] {
  return [
    httpTool(policy, { fetchImpl: config.fetchImpl }) as BridgeTool,
    filesystemTool(policy) as BridgeTool,
    shellTool(policy) as BridgeTool,
    webSearchTool(policy, { ...config.search, fetchImpl: config.search?.fetchImpl }) as BridgeTool,
    imageTool({
      ...config.image,
      fetchImpl: config.image?.fetchImpl ?? config.fetchImpl,
    }) as BridgeTool,
  ];
}
