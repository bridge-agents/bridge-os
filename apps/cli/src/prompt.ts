import { emitKeypressEvents } from "node:readline";

/**
 * The chat input line.
 *
 * `readline.question` reads a whole line and tells you nothing until Enter,
 * which is fine for a password and useless for a command palette: the point
 * of typing "/" is to be shown what exists *before* committing to it. So the
 * chat line is read a keypress at a time, and the matching commands are
 * drawn under the cursor as you type.
 *
 * Everything here is one input line plus the suggestions below it. Nothing
 * else on screen is ever redrawn, which keeps this a few escape codes rather
 * than a screen renderer.
 */
export interface Suggestion {
  name: string;
  summary: string;
}

export interface LineOptions {
  prompt: string;
  /** Matches for the line so far; empty when there is nothing to offer. */
  suggest?(line: string): Suggestion[];
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** How many commands the palette shows at once. */
export const PALETTE_SIZE = 5;

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const invert = (text: string) => `\x1b[7m${text}\x1b[0m`;

/**
 * Commands matching what has been typed so far.
 *
 * Only a line that is *only* a command matches: once there is a space the
 * verb is settled and arguments are being typed, and a palette over the top
 * of them is noise. A bare "/" matches everything, which is how five
 * appear the moment you press it.
 */
export function suggestionsFor(line: string, commands: Suggestion[]): Suggestion[] {
  if (!line.startsWith("/") || line.includes(" ")) return [];
  const typed = line.slice(1).toLowerCase();
  const matches = commands.filter((command) => command.name.toLowerCase().startsWith(typed));
  // Fall back to a looser match so a half-remembered name still finds it.
  const loose = typed
    ? commands.filter(
        (command) =>
          !command.name.toLowerCase().startsWith(typed) &&
          command.name.toLowerCase().includes(typed),
      )
    : [];
  return [...matches, ...loose].slice(0, PALETTE_SIZE);
}

/** Visible width, ignoring the escape codes that colour it. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const width = (text: string) => text.replace(ANSI, "").length;

export interface LineResult {
  /** The submitted text, or undefined when the reader was closed (Ctrl-D). */
  text?: string;
}

export async function readLine(options: LineOptions): Promise<LineResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const suggest = options.suggest ?? (() => []);

  let buffer = "";
  let cursor = 0;
  let selected = 0;

  const columns = () => output.columns ?? 80;
  const clip = (text: string) => {
    const limit = Math.max(8, columns() - 2);
    return width(text) <= limit ? text : `${text.slice(0, limit - 1)}…`;
  };

  const render = () => {
    const rows = suggest(buffer);
    selected = Math.min(selected, Math.max(0, rows.length - 1));

    // Back to the start of our line, then wipe it and everything we drew
    // beneath it. Anything printed above is left alone.
    output.write("\r\x1b[J");
    output.write(options.prompt + buffer);

    rows.forEach((row, index) => {
      const name = `/${row.name}`.padEnd(14);
      const line = clip(
        `  ${index === selected ? invert(` ${name}`) : ` ${name}`} ${dim(row.summary)}`,
      );
      output.write(`\n${line}`);
    });
    if (rows.length) output.write(`\x1b[${rows.length}A`);

    // Put the cursor back where the typist thinks it is.
    const column = width(options.prompt) + cursor;
    output.write("\r");
    if (column > 0) output.write(`\x1b[${column}C`);
  };

  const finish = (text?: string) => {
    output.write("\r\x1b[J");
    output.write(`${options.prompt}${buffer}\n`);
    return { text };
  };

  return new Promise<LineResult>((resolve) => {
    emitKeypressEvents(input);
    const wasRaw = input.isRaw ?? false;
    input.setRawMode?.(true);
    input.resume();

    const done = (result: LineResult) => {
      input.off("keypress", onKey);
      input.setRawMode?.(wasRaw);
      input.pause();
      resolve(result);
    };

    const onKey = (chunk: string | undefined, key: KeyEvent | undefined) => {
      const rows = suggest(buffer);

      if (key?.ctrl && key.name === "c") {
        done(finish(""));
        return;
      }
      if (key?.ctrl && key.name === "d" && buffer === "") {
        done(finish(undefined));
        return;
      }

      switch (key?.name) {
        case "return":
        case "enter": {
          /**
           * Enter takes the highlighted command when the palette is open and
           * the name is not yet complete — otherwise it sends the line. This
           * is why picking a command never needs a second Enter.
           */
          const choice = rows[selected];
          if (choice && buffer !== `/${choice.name}`) {
            buffer = `/${choice.name}`;
            cursor = buffer.length;
            selected = 0;
            render();
            return;
          }
          done(finish(buffer));
          return;
        }
        case "tab": {
          const choice = rows[selected];
          if (choice) {
            buffer = `/${choice.name}`;
            cursor = buffer.length;
          }
          break;
        }
        case "up":
          if (rows.length) selected = (selected - 1 + rows.length) % rows.length;
          break;
        case "down":
          if (rows.length) selected = (selected + 1) % rows.length;
          break;
        case "left":
          cursor = Math.max(0, cursor - 1);
          break;
        case "right":
          cursor = Math.min(buffer.length, cursor + 1);
          break;
        case "home":
          cursor = 0;
          break;
        case "end":
          cursor = buffer.length;
          break;
        case "backspace":
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor -= 1;
            selected = 0;
          }
          break;
        case "delete":
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          break;
        case "escape":
          // Dismiss the palette by clearing what opened it.
          if (buffer.startsWith("/")) {
            buffer = "";
            cursor = 0;
          }
          break;
        default: {
          // A printable character, and nothing that arrived with a modifier.
          if (chunk && !key?.ctrl && !key?.meta && chunk >= " ") {
            buffer = buffer.slice(0, cursor) + chunk + buffer.slice(cursor);
            cursor += chunk.length;
            selected = 0;
          }
        }
      }
      render();
    };

    input.on("keypress", onKey);
    render();
  });
}

interface KeyEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** The prompt Bridge draws, kept here so the chat and the palette agree. */
export const chatPrompt = (slug: string) => `${cyan("›")} ${dim(slug)} `;
