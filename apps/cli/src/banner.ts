/**
 * The Bridge mark, in characters.
 *
 * Drawn from the same shape as the app icon — a span with its deck and two
 * cable stays — because the terminal is a first-class Bridge client, not a
 * fallback for when the app will not open, and it should look like it
 * belongs to the same product.
 */
const MARK = ["  ╱╲    ╱╲  ", " ╱  ╲  ╱  ╲ ", "╱    ╲╱    ╲", "▔▔▔▔▔▔▔▔▔▔▔▔"];

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

export interface BannerContext {
  version?: string;
  agent?: string;
  model?: string;
  /** Terminal width, so a narrow window gets the small mark. */
  columns?: number;
}

/**
 * The greeting.
 *
 * The mark, then plain words. An earlier version spelled BRIDGE out in block
 * capitals across half the terminal, which is the kind of thing that looks
 * impressive once and cheap every time after — this is meant to be opened
 * twenty times a day.
 */
export function banner(context: BannerContext = {}): string {
  const width = context.columns ?? process.stdout.columns ?? 80;
  const detail = [context.agent, context.model].filter(Boolean).join(dim("  ·  "));
  const title = `${bold("Bridge")}  ${dim(context.version ? `Agent OS ${context.version}` : "Agent OS")}`;

  // Side by side when there is room; stacked when there is not.
  if (width < 46) {
    const stacked = ["", ...MARK.map((row) => cyan(row)), "", `  ${title}`];
    if (detail) stacked.push(`  ${detail}`);
    stacked.push("");
    return stacked.join("\n");
  }

  const gutter = "  ";
  return [
    "",
    `${gutter}${cyan(MARK[0] ?? "")}`,
    `${gutter}${cyan(MARK[1] ?? "")}${gutter}${title}`,
    `${gutter}${cyan(MARK[2] ?? "")}${gutter}${detail}`,
    `${gutter}${cyan(MARK[3] ?? "")}`,
    "",
  ].join("\n");
}

/**
 * What you can type while chatting.
 *
 * Shown on `/help`; the palette under the cursor covers the rest of the time.
 */
export function chatHelp(commands: { name: string; summary: string }[]): string {
  const lines = [
    bold("  While you are chatting"),
    `    ${"/help".padEnd(22)}${dim("this list")}`,
    `    ${"/agent <name>".padEnd(22)}${dim("switch to another agent")}`,
    `    ${"/model [id]".padEnd(22)}${dim("list models, or switch to one")}`,
    `    ${"/new".padEnd(22)}${dim("start a fresh conversation")}`,
    `    ${"/runs".padEnd(22)}${dim("recent runs for this agent")}`,
    `    ${"/exit".padEnd(22)}${dim("leave — an empty line or Ctrl-C does too")}`,
    "",
    bold("  Bridge commands — the same ones the web chat box runs"),
  ];
  for (const command of commands) {
    lines.push(`    ${`/${command.name}`.padEnd(22)}${dim(command.summary)}`);
  }
  lines.push("");
  lines.push(dim("  Anything else is a message to your agent."));
  return lines.join("\n");
}
