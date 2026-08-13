import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

/**
 * Telegram over long polling, not webhooks: Bridge Community runs on a laptop
 * behind NAT with no public URL, and a bot must work there. Server and Cloud
 * installs can add a webhook transport later without changing this contract.
 */
export interface TelegramConfig {
  /** Bot token from @BotFather. Resolved from the secret store, never a manifest literal. */
  token: string;
  /** Seconds Telegram holds an empty poll open. Long is cheap and near-instant. */
  pollTimeoutSec?: number;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called when a poll fails. Without it a rejected token is a silent dead bot. */
  onError?: (error: unknown) => void;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: { id: number; username?: string };
  };
}

/** Telegram rejects anything longer; splitting beats a silent 400. */
const MAX_MESSAGE = 4096;

export class TelegramChannel implements Channel {
  readonly type = "telegram";

  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private offset = 0;
  private running = false;
  private controller?: AbortController;
  private loop?: Promise<void>;

  constructor(private readonly config: TelegramConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.base = `${config.apiUrl ?? "https://api.telegram.org"}/bot${config.token}`;
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    const payload = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
    };
    if (!payload.ok)
      throw new Error(`telegram ${method} failed: ${payload.description ?? res.status}`);
    return payload.result as T;
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.loop = this.poll(onMessage);
  }

  private async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (this.running) {
      let updates: TelegramUpdate[];
      try {
        updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: this.config.pollTimeoutSec ?? 25,
            allowed_updates: ["message"],
          },
          this.controller?.signal,
        );
      } catch (error) {
        if (!this.running) return;
        // A dropped connection or a Telegram hiccup must not kill the bot —
        // but a rejected token would otherwise fail forever in silence.
        this.config.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        continue;
      }

      // Yield to the event loop every pass. Telegram normally holds the poll
      // open for `timeout` seconds, but a zero timeout — or a server that
      // answers instantly — would otherwise spin the CPU and starve timers.
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (const update of updates) {
        // Acknowledge before handling: a message that crashes the agent must
        // not be redelivered forever.
        this.offset = update.update_id + 1;
        const text = update.message?.text;
        if (!text) continue;

        await onMessage({
          channel: this.type,
          senderId: String(update.message?.chat.id),
          text,
          raw: update,
        }).catch(() => undefined);
      }
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    for (let at = 0; at < message.text.length; at += MAX_MESSAGE) {
      await this.call("sendMessage", {
        chat_id: message.recipientId,
        text: message.text.slice(at, at + MAX_MESSAGE),
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
  }
}
