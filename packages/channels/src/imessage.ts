import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

const run = promisify(execFile);

export interface IMessageConfig {
  pollMs?: number;
  onError?: (error: unknown) => void;
}

/** macOS Messages adapter using the OS sqlite and AppleScript tools. */
export class IMessageChannel implements Channel {
  readonly type = "imessage";
  private timer?: NodeJS.Timeout;
  private onMessage?: (message: InboundMessage) => Promise<void>;
  private lastRowId = 0;
  private polling = false;

  constructor(private readonly config: IMessageConfig = {}) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (process.platform !== "darwin") throw new Error("iMessage requires macOS");
    this.onMessage = onMessage;
    this.lastRowId = await this.maxRowId();
    this.timer = setInterval(() => void this.poll(), this.config.pollMs ?? 2_000);
  }

  async send(message: OutboundMessage): Promise<void> {
    const script = [
      "on run argv",
      'tell application "Messages"',
      "set targetBuddy to buddy (item 1 of argv) of service 1",
      "send (item 2 of argv) to targetBuddy",
      "end tell",
      "end run",
    ].join("\n");
    await run("osascript", ["-e", script, message.recipientId, message.text]);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async maxRowId(): Promise<number> {
    const { stdout } = await run("sqlite3", [
      this.databasePath(),
      "select max(ROWID) from message;",
    ]);
    return Number(stdout.trim()) || 0;
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.onMessage) return;
    this.polling = true;
    try {
      const sql = `select json_object('id',m.ROWID,'sender',h.id,'text',m.text) from message m left join handle h on h.ROWID=m.handle_id where m.ROWID>${this.lastRowId} and m.is_from_me=0 and m.text is not null order by m.ROWID asc;`;
      const { stdout } = await run("sqlite3", [this.databasePath(), sql]);
      for (const line of stdout.split("\n").filter(Boolean)) {
        const row = JSON.parse(line) as { id: number; sender?: string; text?: string };
        this.lastRowId = Math.max(this.lastRowId, row.id);
        if (row.sender && row.text) {
          await this.onMessage({
            channel: this.type,
            senderId: row.sender,
            text: row.text,
            raw: row,
          });
        }
      }
    } catch (error) {
      this.config.onError?.(error);
    } finally {
      this.polling = false;
    }
  }

  private databasePath(): string {
    return join(homedir(), "Library", "Messages", "chat.db");
  }
}
