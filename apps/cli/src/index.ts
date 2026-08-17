#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { availableCommands, CommandError, parseCommand, usage } from "@bridge/commands";
import { ApiClient, CliError, loadConfig } from "./client.js";
import {
  chat,
  dashboard,
  ensureWorkspace,
  invite,
  login,
  logs,
  runAgent,
  tokens,
  tui,
} from "./commands.js";
import { renderResult } from "./render.js";
import { ensureApi } from "./serve.js";

/**
 * `bridge` — the terminal front door.
 *
 * Most commands are not implemented here: they live in `@bridge/commands`
 * and are shared with the chat box in the web app, so `bridge approve x` and
 * `/approve x` are the same code. What stays local are the ones that need a
 * terminal — an interactive chat, a password prompt, starting a process.
 */
const NATIVE = `  bridge                              start Bridge and chat with your agent
  bridge tui                          same, explicitly
  bridge dashboard                    start Bridge and open the dashboard
  bridge chat [agent]                 chat with a specific agent
  bridge ask <agent> <task…>          send one task and follow it live
  bridge logs <runId>                 a run's full trace and answer
  bridge login <email> [password]     sign in to a remote Bridge server
  bridge token list|create|revoke     manage programmatic API credentials
  bridge invite <email> [role]        invite a workspace member`;

function help(): string {
  const shared = availableCommands("cli")
    .map((command) => `  bridge ${usage(command)}`)
    .join("\n");
  return `bridge — Bridge Agent OS\n\n${NATIVE}\n\n${shared}\n
Running locally needs no account: Bridge starts on demand and remembers this
machine. BRIDGE_API_URL points the CLI at a different Bridge.

The same commands work in the web app: type "/" in any chat box.`;
}

/** Commands that are useless without a running Bridge, so they start one. */
const AUTOSTART = new Set(["", "tui", "dashboard"]);

async function main(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return 0;
  }

  const config = await loadConfig();
  const client = new ApiClient({ apiUrl: config.apiUrl, token: config.token });
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ctx = {
    config,
    client,
    out: (line: string) => console.log(line),
    // Piped or redirected stdin has no one to answer a question — fail with
    // a clear message instead of readline throwing mid-prompt.
    prompt: process.stdin.isTTY ? (question: string) => rl.question(question) : undefined,
  };

  try {
    if (AUTOSTART.has(command)) await ensureApi({ apiUrl: config.apiUrl, out: ctx.out });

    switch (command) {
      // Bare `bridge` is the front door: start everything, then talk.
      case "":
      case "tui":
        await tui(ctx, rest[0]);
        return 0;
      case "dashboard":
        await dashboard(ctx);
        return 0;
      case "chat":
        await chat(ctx, rest[0]);
        return 0;
      case "login": {
        const email = rest[0] ?? (await rl.question("email: "));
        // Falls back to a prompt so a password never has to sit in shell history.
        const password = rest[1] ?? (await rl.question("password: "));
        await login(ctx, email, password);
        return 0;
      }
      case "ask": {
        const [agent, ...task] = rest;
        if (!agent || task.length === 0) throw new CliError("usage: bridge ask <agent> <task…>");
        await runAgent(ctx, agent, task.join(" "));
        return 0;
      }
      case "logs": {
        const runId = rest[0];
        if (!runId) throw new CliError("usage: bridge logs <runId>");
        await logs(ctx, runId);
        return 0;
      }
      case "token": {
        const action = rest[0];
        if (action !== "list" && action !== "create" && action !== "revoke") {
          throw new CliError("usage: bridge token list|create|revoke [value]");
        }
        await tokens(ctx, action, rest.slice(1).join(" ") || undefined);
        return 0;
      }
      case "invite": {
        const email = rest[0];
        const role = rest[1] ?? "member";
        if (!email || (role !== "admin" && role !== "member")) {
          throw new CliError("usage: bridge invite <email> [admin|member]");
        }
        await invite(ctx, email, role);
        return 0;
      }
      default:
        return await runShared(ctx, [command, ...rest].join(" "));
    }
  } catch (error) {
    console.error(
      error instanceof CliError || error instanceof CommandError ? error.message : String(error),
    );
    return 1;
  } finally {
    rl.close();
  }
}

/** Everything defined once in `@bridge/commands`. */
async function runShared(
  ctx: { client: ApiClient; out: (line: string) => void; config: { workspaceId?: string } },
  input: string,
): Promise<number> {
  const { command, args } = parseCommand(input);
  const workspaceId = await ensureWorkspace(ctx as Parameters<typeof ensureWorkspace>[0]);

  const result = await command.run(
    {
      workspaceId,
      request: (path, init) =>
        ctx.client.request(path, {
          ...(init?.method ? { method: init.method } : {}),
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
    },
    args,
  );

  renderResult(result, ctx.out);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
