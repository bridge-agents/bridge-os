import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

/**
 * Discord over the gateway websocket, spoken directly.
 *
 * discord.js would be a large dependency for "receive a message, send a
 * reply", and desktop packaging pays for every dependency three times over.
 * Node 22 has a global WebSocket, so this is the whole client.
 *
 * The bot needs the MESSAGE CONTENT privileged intent enabled in the Discord
 * developer portal, otherwise message text arrives empty.
 */
export interface DiscordConfig {
  /** Bot token. Resolved from the secret store, never a manifest literal. */
  token: string;
  apiUrl?: string;
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}

/** GUILD_MESSAGES | MESSAGE_CONTENT | DIRECT_MESSAGES */
const INTENTS = (1 << 9) | (1 << 15) | (1 << 12);
const MAX_MESSAGE = 2000;

interface GatewayFrame {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export class DiscordChannel implements Channel {
  readonly type = "discord";

  private readonly fetchImpl: typeof fetch;
  private readonly api: string;
  private socket?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private sequence: number | null = null;
  private selfId?: string;
  private running = false;

  constructor(private readonly config: DiscordConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.api = config.apiUrl ?? "https://discord.com/api/v10";
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.running = true;
    const url = this.config.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json";
    const socket = (this.config.socketFactory ?? ((target: string) => new WebSocket(target)))(url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      void this.receive(String(event.data), onMessage);
    });
    socket.addEventListener("close", () => {
      clearInterval(this.heartbeat);
      // ponytail: reconnect is a fresh IDENTIFY, no session resume. Missed
      // messages during the gap are lost; add RESUME if that starts to matter.
      if (this.running) setTimeout(() => void this.start(onMessage), 5_000);
    });
  }

  private sendFrame(frame: GatewayFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private async receive(
    raw: string,
    onMessage: (message: InboundMessage) => Promise<void>,
  ): Promise<void> {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.s != null) this.sequence = frame.s;

    if (frame.op === 10) {
      const { heartbeat_interval: interval } = frame.d as { heartbeat_interval: number };
      this.heartbeat = setInterval(() => this.sendFrame({ op: 1, d: this.sequence }), interval);
      this.sendFrame({
        op: 2,
        d: {
          token: this.config.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: "bridge", device: "bridge" },
        },
      });
      return;
    }

    if (frame.t === "READY") {
      this.selfId = (frame.d as { user: { id: string } }).user.id;
      return;
    }

    if (frame.t === "MESSAGE_CREATE") {
      const message = frame.d as {
        content?: string;
        channel_id: string;
        author?: { id: string; bot?: boolean };
      };
      // Ignore bots, including ourselves — two bots in a room is a loop.
      if (!message.content || message.author?.bot || message.author?.id === this.selfId) return;

      await onMessage({
        channel: this.type,
        senderId: message.channel_id,
        text: message.content,
        raw: message,
      }).catch(() => undefined);
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    for (let at = 0; at < message.text.length; at += MAX_MESSAGE) {
      const res = await this.fetchImpl(`${this.api}/channels/${message.recipientId}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bot ${this.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ content: message.text.slice(at, at + MAX_MESSAGE) }),
      });
      if (!res.ok) throw new Error(`discord sendMessage failed (${res.status})`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    this.socket?.close();
  }
}
