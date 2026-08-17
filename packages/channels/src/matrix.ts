import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

export interface MatrixConfig {
  homeserver: string;
  accessToken: string;
  userId?: string;
  onError?: (error: unknown) => void;
}

export class MatrixChannel implements Channel {
  readonly type = "matrix";
  private controller?: AbortController;
  private since?: string;

  constructor(private readonly config: MatrixConfig) {}

  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.controller = new AbortController();
    void this.sync(onMessage);
  }

  async send(message: OutboundMessage): Promise<void> {
    const txn = crypto.randomUUID();
    const response = await fetch(
      `${this.base()}/_matrix/client/v3/rooms/${encodeURIComponent(message.recipientId)}/send/m.room.message/${txn}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ msgtype: "m.text", body: message.text }),
      },
    );
    if (!response.ok) throw new Error(`Matrix send failed (${response.status})`);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
  }

  private async sync(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.controller?.signal.aborted) {
      try {
        const url = new URL(`${this.base()}/_matrix/client/v3/sync`);
        url.searchParams.set("timeout", "30000");
        if (this.since) url.searchParams.set("since", this.since);
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${this.config.accessToken}` },
          signal: this.controller?.signal,
        });
        if (!response.ok) throw new Error(`Matrix sync failed (${response.status})`);
        const body = (await response.json()) as {
          next_batch?: string;
          rooms?: {
            join?: Record<
              string,
              { timeline?: { events?: { sender?: string; type?: string; content?: unknown }[] } }
            >;
          };
        };
        this.since = body.next_batch ?? this.since;
        for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            const content = event.content as { msgtype?: string; body?: string } | undefined;
            if (
              event.type === "m.room.message" &&
              content?.msgtype === "m.text" &&
              content.body &&
              event.sender !== this.config.userId
            ) {
              await onMessage({
                channel: this.type,
                senderId: roomId,
                text: content.body,
                raw: event,
              });
            }
          }
        }
      } catch (error) {
        if (this.controller?.signal.aborted) break;
        this.config.onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private base(): string {
    return this.config.homeserver.replace(/\/$/, "");
  }
}
