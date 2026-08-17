import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";

/** Serializes outbound delivery, applies a minimum interval, and retries transient failures. */
export class ReliableChannel implements Channel {
  readonly type: string;
  private tail = Promise.resolve();
  private lastSentAt = 0;

  constructor(
    private readonly inner: Channel,
    private readonly options: { minIntervalMs?: number; maxAttempts?: number } = {},
  ) {
    this.type = inner.type;
  }

  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    return this.inner.start(onMessage);
  }

  send(message: OutboundMessage): Promise<void> {
    const delivery = this.tail.then(() => this.deliver(message));
    this.tail = delivery.catch(() => undefined);
    return delivery;
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  private async deliver(message: OutboundMessage): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const delay = Math.max(
        0,
        (this.options.minIntervalMs ?? 50) - (Date.now() - this.lastSentAt),
      );
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.inner.send(message);
        this.lastSentAt = Date.now();
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
  }
}
