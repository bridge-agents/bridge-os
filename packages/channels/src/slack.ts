import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

export interface SlackConfig {
  /** Socket Mode app token (`xapp-...`) and bot token (`xoxb-...`). */
  appToken: string;
  botToken: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => WebSocket;
  onError?: (error: unknown) => void;
}

interface SlackEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    event?: {
      type?: string;
      text?: string;
      channel?: string;
      bot_id?: string;
      subtype?: string;
    };
  };
}

/** Slack Socket Mode works from local Bridge installs without a public webhook URL. */
export class SlackChannel implements Channel {
  readonly type = "slack";
  private readonly fetchImpl: typeof fetch;
  private readonly api: string;
  private socket?: WebSocket;
  private running = false;

  constructor(private readonly config: SlackConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.api = config.apiUrl ?? "https://slack.com/api";
  }

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.connect(onMessage);
  }

  private async connect(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const response = await this.fetchImpl(`${this.api}/apps.connections.open`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.appToken}` },
    });
    const opened = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      url?: string;
      error?: string;
    };
    if (!response.ok || !opened.ok || !opened.url) {
      throw new Error(`slack socket connection failed: ${opened.error ?? response.status}`);
    }

    const socket = (this.config.socketFactory ?? ((url: string) => new WebSocket(url)))(opened.url);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.receive(String(event.data), onMessage);
    });
    socket.addEventListener("close", () => {
      if (!this.running) return;
      setTimeout(() => {
        void this.connect(onMessage).catch(this.config.onError);
      }, 3_000);
    });
  }

  private async receive(
    raw: string,
    onMessage: (message: InboundMessage) => Promise<void>,
  ): Promise<void> {
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(raw) as SlackEnvelope;
    } catch {
      return;
    }

    // Socket Mode requires an acknowledgement within three seconds.
    if (envelope.envelope_id) {
      this.socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type !== "events_api") return;

    const event = envelope.payload?.event;
    if (
      event?.type !== "message" ||
      !event.text ||
      !event.channel ||
      event.bot_id ||
      event.subtype
    ) {
      return;
    }
    await onMessage({
      channel: this.type,
      senderId: event.channel,
      text: event.text,
      raw: envelope,
    }).catch(this.config.onError);
  }

  async send(message: OutboundMessage): Promise<void> {
    const response = await this.fetchImpl(`${this.api}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: message.recipientId, text: message.text }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      throw new Error(`slack chat.postMessage failed: ${body.error ?? response.status}`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.socket?.close();
  }
}
