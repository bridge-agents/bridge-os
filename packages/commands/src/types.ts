/**
 * Bridge commands, defined once and run from anywhere.
 *
 * `bridge approve abc` in a terminal and `/approve abc` in the chat box are
 * the same command — not two implementations that drift until one of them
 * grows a feature the other never gets. So a command is a value here: a
 * name, its arguments, and a function that talks to the public API and
 * returns structured output the caller renders however suits it.
 *
 * The rule that makes this work: a command never formats for a terminal and
 * never touches the DOM. It returns text, a table, or somewhere to go, and
 * the CLI prints it while the web draws it.
 */
export interface CommandContext {
  workspaceId: string;
  /**
   * The only way a command reaches Bridge. Both clients already have one of
   * these, and neither gets a private path into the domain (ADR-0005).
   */
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

/** A cell in command output. Objects and arrays are the caller's problem. */
export type Cell = string | number | null;

export interface CommandTable {
  columns: string[];
  rows: Cell[][];
}

export interface CommandResult {
  /** The answer in words. Always set for commands whose answer is a sentence. */
  text?: string;
  /** Rows, when the answer is a list. */
  table?: CommandTable;
  /** A client route worth going to afterwards. The CLI ignores it. */
  navigate?: string;
  /**
   * True when the command changed something. Clients use it to refresh, and
   * it is why a read-only command can never quietly become a write.
   */
  changed?: boolean;
}

export type ArgSuggest = "agent" | "automation" | "approval" | "run" | "provider";

export interface CommandArg {
  name: string;
  description: string;
  required?: boolean;
  /** Swallows the remaining words, for free text like a task description. */
  rest?: boolean;
  /** What a client can offer as completions. */
  suggest?: ArgSuggest;
}

export interface CommandDef {
  /** What the user types, without a prefix: "agent list", "approve". */
  name: string;
  summary: string;
  args?: CommandArg[];
  /** Grouping for help and the palette. */
  group: "agents" | "runs" | "automations" | "approvals" | "workspace";
  /**
   * Needs a terminal — a browser tab cannot start a process or read a
   * password, and offering the command there would be a dead end.
   */
  cliOnly?: boolean;
  /** Changes something; clients confirm destructive ones before running. */
  destructive?: boolean;
  run(ctx: CommandContext, args: Record<string, string>): Promise<CommandResult>;
}

export class CommandError extends Error {}
