import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  Provider,
  ToolCall,
} from "@bridge/sdk";

const executeFile = promisify(execFile);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export type CliProviderId = "codex" | "claude-code" | "github-copilot";

export interface CliAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  account?: string;
  plan?: string;
  error?: string;
}

/** Subscription credentials stay in the vendor CLI/keychain; Bridge only invokes the CLI. */
export class CliSubscriptionProvider implements Provider {
  constructor(readonly id: CliProviderId) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const workDir = await mkdtemp(join(tmpdir(), `bridge-${this.id}-`));
    try {
      const fileNotes: string[] = [];
      const imagePaths: string[] = [];
      for (const message of request.messages) {
        for (const attachment of message.attachments ?? []) {
          const filename = `${attachment.id}-${safeName(attachment.name)}`;
          const path = join(workDir, filename);
          await writeFile(path, Buffer.from(attachment.dataBase64, "base64"));
          fileNotes.push(`- ${attachment.name}: ${path}`);
          if (attachment.mimeType.startsWith("image/")) imagePaths.push(path);
        }
      }

      const schema = outputSchema(request);
      const prompt = renderPrompt(request, fileNotes);
      const parsed =
        this.id === "codex"
          ? await this.runCodex(request, prompt, schema, workDir, imagePaths)
          : this.id === "claude-code"
            ? await this.runClaude(request, prompt, schema, workDir)
            : await this.runCopilot(request, prompt, workDir);

      const toolCalls = normalizeToolCalls(parsed.toolCalls);
      return {
        message: {
          role: "assistant",
          content: typeof parsed.content === "string" ? parsed.content : "",
          ...(toolCalls.length ? { toolCalls } : {}),
        },
        usage: parsed.usage ?? { inputTokens: 0, outputTokens: 0 },
        stopReason: toolCalls.length ? "tool_use" : "end",
        model: request.model,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.id === "claude-code") return CLAUDE_CODE_MODELS;
    if (this.id === "github-copilot") return GITHUB_COPILOT_MODELS;

    try {
      const { stdout } = await executeFile("codex", ["debug", "models"], {
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      const catalog = JSON.parse(stdout) as {
        models?: {
          slug?: string;
          display_name?: string;
          visibility?: string;
          supported_reasoning_levels?: { effort?: string }[];
          additional_speed_tiers?: string[];
          input_modalities?: string[];
        }[];
      };
      return (catalog.models ?? []).flatMap((model) => {
        if (!model.slug || model.visibility !== "list") return [];
        return [
          {
            id: model.slug,
            displayName: model.display_name,
            reasoningEfforts: model.supported_reasoning_levels
              ?.map((entry) => entry.effort)
              .filter(isReasoningEffort),
            serviceTiers: model.additional_speed_tiers?.includes("fast")
              ? (["default", "fast"] as const)
              : (["default"] as const),
            inputModalities: ["text", "image", "file"] as const,
          },
        ];
      });
    } catch {
      return CODEX_MODELS;
    }
  }

  private async runCodex(
    request: CompletionRequest,
    prompt: string,
    schema: Record<string, unknown>,
    workDir: string,
    imagePaths: string[],
  ): Promise<CliResult> {
    const schemaPath = join(workDir, "output-schema.json");
    const outputPath = join(workDir, "output.json");
    await writeFile(schemaPath, JSON.stringify(schema));

    const args = [
      "exec",
      // Auth still comes from CODEX_HOME, but workspace-level MCP servers,
      // rules, and feature settings must not escape Bridge's tool policy.
      "--ignore-user-config",
      "--model",
      request.model,
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--json",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      ...imagePaths.flatMap((path) => ["--image", path]),
      ...(request.reasoningEffort && request.reasoningEffort !== "none"
        ? ["-c", `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`]
        : []),
      ...(request.serviceTier === "fast" ? ["--enable", "fast_mode"] : []),
      ...(request.serviceTier === "fast" ? ["-c", 'service_tier="fast"'] : []),
      prompt,
    ];
    const { stdout } = await spawnFile("codex", args, {
      cwd: workDir,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 900_000,
    });
    const result = parseCliResult(await readFile(outputPath, "utf8"));
    const usage = codexUsage(stdout);
    if (usage) result.usage = usage;
    return result;
  }

  private async runClaude(
    request: CompletionRequest,
    prompt: string,
    schema: Record<string, unknown>,
    workDir: string,
  ): Promise<CliResult> {
    const args = [
      "-p",
      prompt,
      "--model",
      request.model,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--safe-mode",
      ...(request.reasoningEffort && request.reasoningEffort !== "none"
        ? ["--effort", request.reasoningEffort]
        : []),
    ];
    const { stdout } = await spawnFile("claude", args, {
      cwd: workDir,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 900_000,
    });
    const envelope = JSON.parse(stdout) as {
      structured_output?: unknown;
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const result =
      typeof envelope.structured_output === "object" && envelope.structured_output !== null
        ? (envelope.structured_output as CliResult)
        : parseCliResult(envelope.result ?? "");
    result.usage = {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
    };
    return result;
  }

  private async runCopilot(
    request: CompletionRequest,
    prompt: string,
    workDir: string,
  ): Promise<CliResult> {
    const copilotPrompt = `${prompt}\n\nOUTPUT JSON SCHEMA:\n${JSON.stringify(outputSchema(request))}`;
    const { stdout } = await spawnFile(
      "copilot",
      [
        "-p",
        copilotPrompt,
        "-s",
        "--model",
        request.model,
        "--no-ask-user",
        // The Bridge runtime owns tool execution and approvals. Copilot only
        // produces the structured request from the isolated temporary folder.
        "--deny-tool",
        "shell(*)",
      ],
      { cwd: workDir, maxBuffer: MAX_OUTPUT_BYTES, timeout: 900_000 },
    );
    return parseCliResult(stdout);
  }
}

/** Run an inference CLI with stdin closed; both CLIs otherwise wait for more prompt input. */
function spawnFile(
  executable: string,
  args: string[],
  options: { cwd: string; maxBuffer: number; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${executable} timed out`));
    }, options.timeout);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`${executable} produced too much output`));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else {
        const stderrText = Buffer.concat(stderr).toString().trim();
        const stdoutText = Buffer.concat(stdout).toString().trim();
        finish(
          new Error(
            `${executable} exited with code ${code}: ${stderrText || stdoutText || "no error details"}`,
          ),
        );
      }
    });
  });
}

export async function cliAuthStatus(provider: CliProviderId): Promise<CliAuthStatus> {
  try {
    if (provider === "codex") {
      const { stdout, stderr } = await executeFile("codex", ["login", "status"], {
        timeout: 10_000,
      });
      const message = `${stdout}\n${stderr}`.trim();
      return { installed: true, loggedIn: /logged in/i.test(message), account: message };
    }

    if (provider === "github-copilot") {
      const { stdout } = await executeFile("copilot", ["version"], { timeout: 10_000 });
      const tokenPresent = Boolean(
        process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
      );
      if (tokenPresent) {
        return {
          installed: true,
          loggedIn: true,
          account: "Environment credential",
          plan: stdout.trim(),
        };
      }
      if (process.platform === "darwin") {
        try {
          await executeFile("security", ["find-generic-password", "-s", "copilot-cli"], {
            timeout: 10_000,
          });
          return {
            installed: true,
            loggedIn: true,
            account: "macOS Keychain",
            plan: stdout.trim(),
          };
        } catch {
          // GitHub CLI is Copilot's documented lowest-priority credential fallback.
        }
      }
      try {
        await executeFile("gh", ["auth", "status"], { timeout: 10_000 });
        return { installed: true, loggedIn: true, account: "GitHub CLI", plan: stdout.trim() };
      } catch {
        return { installed: true, loggedIn: false, plan: stdout.trim() };
      }
    }

    const { stdout } = await executeFile("claude", ["auth", "status", "--json"], {
      timeout: 10_000,
    });
    const status = JSON.parse(stdout) as {
      loggedIn?: boolean;
      email?: string;
      subscriptionType?: string;
    };
    return {
      installed: true,
      loggedIn: status.loggedIn === true,
      account: status.email,
      plan: status.subscriptionType,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /ENOENT|not found/i.test(message);
    return { installed: !missing, loggedIn: false, error: message };
  }
}

const CODEX_MODELS: ModelInfo[] = [
  codexModel("gpt-5.6-sol", "GPT-5.6-Sol", true, true),
  codexModel("gpt-5.6-terra", "GPT-5.6-Terra", true, true),
  codexModel("gpt-5.6-luna", "GPT-5.6-Luna", true, true),
  codexModel("gpt-5.5", "GPT-5.5", true, true),
  codexModel("gpt-5.4", "GPT-5.4", true, true),
  codexModel("gpt-5.4-mini", "GPT-5.4 Mini", true, false),
];

const CLAUDE_CODE_MODELS: ModelInfo[] = [
  claudeModel("sonnet", "Claude Sonnet"),
  claudeModel("opus", "Claude Opus"),
  claudeModel("fable", "Claude Fable"),
  claudeModel("haiku", "Claude Haiku"),
];

const GITHUB_COPILOT_MODELS: ModelInfo[] = [
  copilotModel("claude-sonnet-4.6", "Claude Sonnet 4.6"),
  copilotModel("gpt-5.4", "GPT-5.4"),
  copilotModel("claude-haiku-4.5", "Claude Haiku 4.5"),
  copilotModel("gpt-5.3-codex", "GPT-5.3 Codex"),
  copilotModel("gemini-3.1-pro-preview", "Gemini 3.1 Pro"),
  copilotModel("gemini-3.5-flash", "Gemini 3.5 Flash"),
  copilotModel("gemini-3.6-flash", "Gemini 3.6 Flash"),
  copilotModel("mai-code-1-flash", "MAI Code 1 Flash"),
];

function codexModel(id: string, displayName: string, reasoning: boolean, fast: boolean): ModelInfo {
  return {
    id,
    displayName,
    reasoningEfforts: reasoning ? ["low", "medium", "high", "xhigh", "max"] : [],
    serviceTiers: fast ? ["default", "fast"] : ["default"],
    inputModalities: ["text", "image", "file"],
  };
}

function claudeModel(id: string, displayName: string): ModelInfo {
  return {
    id,
    displayName,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    serviceTiers: ["default"],
    inputModalities: ["text", "image", "file"],
  };
}

function copilotModel(id: string, displayName: string): ModelInfo {
  return {
    id,
    displayName,
    reasoningEfforts: /gpt|claude-sonnet|gemini.*pro/i.test(id) ? ["low", "medium", "high"] : [],
    serviceTiers: ["default"],
    inputModalities: ["text", "image", "file"],
  };
}

function outputSchema(request: CompletionRequest): Record<string, unknown> {
  const names = request.tools?.map((tool) => tool.name) ?? [];
  return {
    type: "object",
    properties: {
      content: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: names.length ? { type: "string", enum: names } : { type: "string" },
            argumentsJson: {
              type: "string",
              description: "A JSON object encoded as a string containing the tool arguments.",
            },
          },
          required: ["id", "name", "argumentsJson"],
          additionalProperties: false,
        },
        ...(names.length ? {} : { maxItems: 0 }),
      },
    },
    required: ["content", "toolCalls"],
    additionalProperties: false,
  };
}

function renderPrompt(request: CompletionRequest, fileNotes: string[]): string {
  const transcript = request.messages
    .map((message) => {
      const calls = message.toolCalls?.length
        ? `\nBRIDGE TOOL REQUESTS: ${JSON.stringify(message.toolCalls)}`
        : "";
      const resultFor = message.toolCallId ? ` (result for ${message.toolCallId})` : "";
      return `${message.role.toUpperCase()}${resultFor}: ${message.content}${calls}`;
    })
    .join("\n\n");
  const tools = request.tools?.length
    ? `\n\nBRIDGE TOOLS:\n${request.tools
        .map(
          (tool) =>
            `- ${tool.name}: ${tool.description}\n  input: ${JSON.stringify(tool.inputSchema)}`,
        )
        .join("\n")}`
    : "";
  const files = fileNotes.length
    ? `\n\nATTACHED FILES (read only these paths when needed):\n${fileNotes.join("\n")}`
    : "";
  return `${transcript}${files}${tools}\n\nReturn JSON matching the supplied schema. Answer in content when finished. To ask Bridge to execute a tool, leave content empty and return the requested Bridge tool calls with each tool's arguments encoded in argumentsJson; do not execute those tools yourself.`;
}

function parseCliResult(raw: string): CliResult {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as CliResult;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]) as CliResult;
    return { content: trimmed, toolCalls: [] };
  }
}

function codexUsage(stdout: string): CliResult["usage"] {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (event.type === "turn.completed" && event.usage) {
        return {
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
        };
      }
    } catch {
      // Non-event output is ignored; the final message is read from its file.
    }
  }
  return undefined;
}

interface CliResult {
  content?: string;
  toolCalls?: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((call, index) => {
    if (typeof call !== "object" || call === null) return [];
    const record = call as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    return [
      {
        id: typeof record.id === "string" ? record.id : `call_${index}`,
        name: record.name,
        arguments: parseArgumentsJson(record.argumentsJson),
      },
    ];
  });
}

function parseArgumentsJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "attachment";
}

function isReasoningEffort(
  value: string | undefined,
): value is NonNullable<ModelInfo["reasoningEfforts"]>[number] {
  return ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value ?? "");
}
