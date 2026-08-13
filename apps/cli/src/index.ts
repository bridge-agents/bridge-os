#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { ApiClient, CliError, loadConfig } from "./client.js";
import {
  chat,
  dashboard,
  decideApproval,
  listAgents,
  listApprovals,
  listRuns,
  login,
  logs,
  runAgent,
  status,
  tui,
} from "./commands.js";
import { ensureApi } from "./serve.js";

const USAGE = `bridge — Bridge Agent OS

  bridge                              start Bridge and chat with your agent
  bridge tui                          same, explicitly
  bridge dashboard                    start Bridge and open the dashboard

  bridge status                       health, agents, pending approvals
  bridge agent list                   list agents
  bridge agent run <agent> <task…>    send one task and follow it live
  bridge chat [agent]                 chat with a specific agent
  bridge runs <agent>                 recent runs
  bridge logs <runId>                 a run's trace and answer
  bridge approvals                    what is waiting on you
  bridge approve <approvalId>         let a paused run continue
  bridge deny <approvalId> [reason]   refuse, with a reason for the agent
  bridge login <email> [password]     sign in to a remote Bridge server

Running locally needs no account: Bridge starts on demand and remembers this
machine. BRIDGE_API_URL points the CLI at a different Bridge.`;

/** Commands that are useless without a running Bridge, so they start one. */
const AUTOSTART = new Set(["", "tui", "dashboard"]);

async function main(argv: string[]): Promise<number> {
  const [command = "", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
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
      case "login": {
        const email = rest[0] ?? (await rl.question("email: "));
        // Falls back to a prompt so a password never has to sit in shell history.
        const password = rest[1] ?? (await rl.question("password: "));
        await login(ctx, email, password);
        return 0;
      }
      case "status":
        await status(ctx);
        return 0;
      case "agent": {
        const [sub, ...args] = rest;
        if (sub === "list") await listAgents(ctx);
        else if (sub === "run") {
          const [agent, ...task] = args;
          if (!agent || task.length === 0)
            throw new CliError("usage: bridge agent run <agent> <task…>");
          await runAgent(ctx, agent, task.join(" "));
        } else throw new CliError("usage: bridge agent <list|run>");
        return 0;
      }
      case "chat":
        await chat(ctx, rest[0]);
        return 0;
      case "runs": {
        const agent = rest[0];
        if (!agent) throw new CliError("usage: bridge runs <agent>");
        await listRuns(ctx, agent);
        return 0;
      }
      case "logs": {
        const runId = rest[0];
        if (!runId) throw new CliError("usage: bridge logs <runId>");
        await logs(ctx, runId);
        return 0;
      }
      case "approvals":
        await listApprovals(ctx);
        return 0;
      case "approve":
      case "deny": {
        const [approvalId, ...reason] = rest;
        if (!approvalId) throw new CliError(`usage: bridge ${command} <approvalId>`);
        await decideApproval(ctx, approvalId, command === "approve", reason.join(" ") || undefined);
        return 0;
      }
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    console.error(error instanceof CliError ? error.message : String(error));
    return 1;
  } finally {
    rl.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
