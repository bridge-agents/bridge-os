/**
 * Channel adapter contract (ADR-0007). The runtime sees inbound/outbound
 * messages; it never sees a Telegram or Discord API.
 */

export interface InboundMessage {
  /** Channel adapter type, e.g. "telegram". */
  channel: string;
  /** Channel-native sender identifier. */
  senderId: string;
  text: string;
  /** Original channel payload for adapter-specific needs. */
  raw?: unknown;
}

export interface OutboundMessage {
  recipientId: string;
  text: string;
}

export interface Channel {
  readonly type: string;
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop(): Promise<void>;
}
