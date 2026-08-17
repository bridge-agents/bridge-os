import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

const run = promisify(execFile);

export interface SignalConfig {
  account: string;
  command?: string;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export class SignalChannel implements Channel {
  readonly type = "signal";
  private timer?: NodeJS.Timeout;
  private onMessage?: (message: InboundMessage) => Promise<void>;
  private polling = false;

  constructor(private readonly config: SignalConfig) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (!this.config.account) throw new Error("Signal needs a linked account number");
    this.onMessage = onMessage;
    await run(this.config.command ?? "signal-cli", ["--version"]);
    this.timer = setInterval(() => void this.poll(), this.config.pollMs ?? 2_000);
  }

  async send(message: OutboundMessage): Promise<void> {
    await run(this.config.command ?? "signal-cli", [
      "-a",
      this.config.account,
      "send",
      "-m",
      message.text,
      message.recipientId,
    ]);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.onMessage) return;
    this.polling = true;
    try {
      const { stdout } = await run(this.config.command ?? "signal-cli", [
        "-a",
        this.config.account,
        "--output=json",
        "receive",
        "--timeout",
        "1",
      ]);
      for (const line of stdout.split("\n").filter(Boolean)) {
        const event = JSON.parse(line) as {
          envelope?: {
            source?: string;
            sourceNumber?: string;
            sourceUuid?: string;
            dataMessage?: { message?: string };
          };
        };
        const sender =
          event.envelope?.sourceNumber ?? event.envelope?.source ?? event.envelope?.sourceUuid;
        const text = event.envelope?.dataMessage?.message;
        if (sender && text) {
          await this.onMessage({ channel: this.type, senderId: sender, text, raw: event });
        }
      }
    } catch (error) {
      this.config.onError?.(error);
    } finally {
      this.polling = false;
    }
  }
}
