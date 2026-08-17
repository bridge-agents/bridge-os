import { id, type Logger } from "@bridge/core";
import { conversations, type Db, runs } from "@bridge/db";
import { enqueueRun } from "@bridge/runtime";
import type { Channel, InboundMessage } from "@bridge/sdk";
import { and, eq } from "drizzle-orm";

/**
 * Binds one channel to one agent.
 *
 * Everything channel-specific stops at the {@link Channel} adapter: this only
 * knows "a message arrived from someone" and "here is the answer". The runtime
 * knows even less — a channel run is an ordinary run with trigger "channel",
 * so approvals, tools, costs and the run inspector work unchanged (ADR-0007).
 */
export interface ChannelRunnerOptions {
  db: Db;
  logger: Logger;
  workspaceId: string;
  agentId: string;
  channel: Channel;
  /** How often to check whether the run finished. */
  pollMs?: number;
  /** Give up waiting after this long; the run itself keeps going. */
  timeoutMs?: number;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export class ChannelRunner {
  constructor(private readonly options: ChannelRunnerOptions) {}

  start(): Promise<void> {
    return this.options.channel.start((message) => this.handle(message));
  }

  stop(): Promise<void> {
    return this.options.channel.stop();
  }

  private async handle(message: InboundMessage): Promise<void> {
    const reply = await processChannelMessage(this.options, message);
    if (reply) await this.options.channel.send({ recipientId: message.senderId, text: reply });
  }
}

/** Process one webhook or adapter message through the ordinary durable run path. */
export async function processChannelMessage(
  options: Omit<ChannelRunnerOptions, "channel"> & { channel: Pick<Channel, "type"> },
  message: InboundMessage,
): Promise<string> {
  const { db, logger, workspaceId, agentId, channel } = options;
  const externalId = `${message.channel}:${message.senderId}`;
  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), eq(conversations.externalId, externalId)));
  let conversationId = existing?.id;
  if (!conversationId) {
    const [created] = await db
      .insert(conversations)
      .values({ id: id("cnv"), workspaceId, agentId, title: externalId, externalId })
      .onConflictDoNothing({ target: [conversations.agentId, conversations.externalId] })
      .returning({ id: conversations.id });
    conversationId = created?.id;
  }
  if (!conversationId) {
    const [raced] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.externalId, externalId)));
    conversationId = raced?.id;
  }
  if (!conversationId) throw new Error("could not open a conversation for this channel message");

  const runId = await enqueueRun(db, {
    workspaceId,
    agentId,
    conversationId,
    text: message.text,
    trigger: "channel",
  });
  logger.info({ runId, channel: channel.type }, "channel message queued");

  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    const [run] = await db
      .select({ status: runs.status, output: runs.output, error: runs.error })
      .from(runs)
      .where(eq(runs.id, runId));
    if (run && (TERMINAL.has(run.status) || run.status === "waiting_approval")) {
      return run.status === "succeeded"
        ? ((run.output as { content?: string } | null)?.content ?? "")
        : run.status === "waiting_approval"
          ? "This needs your approval in Bridge before I can continue."
          : `Sorry — that failed.${run.error ? ` (${run.error})` : ""}`;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  logger.warn({ runId }, "channel gave up waiting for a run");
  return "The request is still running in Bridge; check the conversation there for the result.";
}
