import { commands } from "./commands.js";
import { type CommandDef, CommandError } from "./types.js";

/**
 * Finding and parsing a command.
 *
 * Names can contain spaces ("agent list"), so matching is longest-first:
 * otherwise "agent" would swallow "agent list" and the more specific command
 * would be unreachable.
 */
const byLength = [...commands].sort((a, b) => b.name.length - a.name.length);

export { commands };

export function findCommand(input: string): CommandDef | undefined {
  const normalized = input.trim().replace(/^\//, "").toLowerCase();
  return byLength.find(
    (command) => normalized === command.name || normalized.startsWith(`${command.name} `),
  );
}

export interface ParsedCommand {
  command: CommandDef;
  args: Record<string, string>;
}

/**
 * Turn a typed line into a command and its arguments.
 *
 * Quotes are honoured so a task can contain spaces, and the last argument
 * may be declared `rest` to take everything left over — which is what makes
 * `run assistant summarise my week` work without quoting.
 */
export function parseCommand(input: string): ParsedCommand {
  const command = findCommand(input);
  if (!command) {
    const name = input.trim().replace(/^\//, "").split(" ")[0] ?? "";
    throw new CommandError(`Unknown command "${name}". Type /help to see what Bridge can do.`);
  }

  const normalized = input.trim().replace(/^\//, "");
  const words = tokenize(normalized.slice(command.name.length).trim());
  const args: Record<string, string> = {};

  const spec = command.args ?? [];
  spec.forEach((arg, index) => {
    const value = arg.rest ? words.slice(index).join(" ") : words[index];
    if (value) args[arg.name] = value;
  });

  const missing = spec.filter((arg) => arg.required && !args[arg.name]);
  if (missing.length) {
    throw new CommandError(
      `${usage(command)}\n\nMissing: ${missing.map((a) => a.name).join(", ")}`,
    );
  }
  return { command, args };
}

/** Split on spaces, keeping quoted runs together. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = pattern.exec(input);
  while (match) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = pattern.exec(input);
  }
  return out;
}

export function usage(command: CommandDef): string {
  const args = (command.args ?? [])
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  return `${command.name}${args ? ` ${args}` : ""} — ${command.summary}`;
}

/**
 * Commands a client should offer.
 *
 * The web omits the ones that need a terminal rather than showing them and
 * failing: a command you can see but cannot run is worse than one that is
 * not there.
 */
export function availableCommands(surface: "cli" | "web"): CommandDef[] {
  return commands.filter((command) => surface === "cli" || !command.cliOnly);
}

/** Ranked matches for what has been typed so far, for a palette. */
export function searchCommands(query: string, surface: "cli" | "web" = "web"): CommandDef[] {
  const needle = query.trim().replace(/^\//, "").toLowerCase();
  const pool = availableCommands(surface);
  if (!needle) return pool;

  return pool
    .map((command) => ({ command, score: score(command, needle) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

function score(command: CommandDef, needle: string): number {
  const name = command.name.toLowerCase();
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 80;
  // A word inside the name: "list" should find "agent list".
  if (name.split(" ").some((word) => word.startsWith(needle))) return 60;
  if (name.includes(needle)) return 40;
  if (command.summary.toLowerCase().includes(needle)) return 20;
  return 0;
}
