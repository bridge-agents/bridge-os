import type { CommandResult, CommandTable } from "@bridge/commands";

/**
 * Turning a command's structured result into terminal output.
 *
 * Commands return data, never formatted text, so this is the only place that
 * knows about column widths and ANSI codes — and the web renderer is its
 * counterpart, drawing the same result as a table in the page.
 */
const dim = (text: string) => `[2m${text}[0m`;

const FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
];

/**
 * Something moving while nothing is arriving.
 *
 * The wait before a model's first token is the same either way, but a still
 * cursor makes it feel broken and a moving one makes it feel busy. Silent
 * when stdout is not a terminal, so piped output stays clean.
 */
export function spinner(label: string, output: NodeJS.WriteStream = process.stdout) {
  if (!output.isTTY) return { stop: () => {} };

  let frame = 0;
  const draw = () => {
    output.write(`\r\x1b[2K  ${dim(`${FRAMES[frame % FRAMES.length]} ${label}`)}`);
    frame += 1;
  };
  draw();
  const timer = setInterval(draw, 80);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      output.write("\r\x1b[2K");
    },
  };
}

export function renderResult(result: CommandResult, out: (line: string) => void): void {
  if (result.text) out(result.text);
  if (result.table) renderTable(result.table, out);
}

function renderTable(table: CommandTable, out: (line: string) => void): void {
  const cells = table.rows.map((row) => row.map((cell) => (cell === null ? "—" : String(cell))));

  // Size each column to its widest value, capped so one long id cannot push
  // everything else off the screen.
  const widths = table.columns.map((column, index) =>
    Math.min(44, Math.max(column.length, ...cells.map((row) => (row[index] ?? "").length), 0)),
  );

  out(dim(table.columns.map((column, i) => pad(column, widths[i] ?? 0)).join("  ")));
  for (const row of cells) {
    out(row.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  "));
  }
}

function pad(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return clipped.padEnd(width);
}
