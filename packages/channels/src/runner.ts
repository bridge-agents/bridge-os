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

  /**
   * One conversation per channel sender, so the agent remembers a chat across
   * messages and across restarts.
   */
  private async conversationFor(message: InboundMessage): Promise<string> {
    const { db, workspaceId, agentId } = this.options;
    const externalId = `${message.channel}:${message.senderId}`;

    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.externalId, externalId)));
    if (existing) return existing.id;

    const [created] = await db
      .insert(conversations)
      .values({
        id: id("cnv"),
        workspaceId,
        agentId,
        title: externalId,
        externalId,
      })
      // Two messages arriving together would otherwise race to create the thread.
      .onConflictDoNothing({ target: [conversations.agentId, conversations.externalId] })
      .returning({ id: conversations.id });
    if (created) return created.id;

    const [raced] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.externalId, externalId)));
    if (!raced) throw new Error("could not open a conversation for this channel message");
    return raced.id;
  }

  private async handle(message: InboundMessage): Promise<void> {
    const { db, logger, workspaceId, agentId, channel } = this.options;

    const conversationId = await this.conversationFor(message);
    const runId = await enqueueRun(db, {
      workspaceId,
      agentId,
      conversationId,
      text: message.text,
      trigger: "channel",
    });
    logger.info({ runId, channel: channel.type }, "channel message queued");

    const run = await this.waitFor(runId);
    const reply =
      run?.status === "succeeded"
        ? ((run.output as { content?: string } | null)?.content ?? "")
        : run?.status === "waiting_approval"
          ? "This needs your approval in Bridge before I can continue."
          : `Sorry — that failed.${run?.error ? ` (${run.error})` : ""}`;

    if (reply) await channel.send({ recipientId: message.senderId, text: reply });
  }

  /**
   * ponytail: polls the runs table. Correct on every topology (the executor may
   * be another process); swap for the run bus if the poll ever shows up in a
   * profile.
   */
  private async waitFor(runId: string) {
    const pollMs = this.options.pollMs ?? 500;
    const deadline = Date.now() + (this.options.timeoutMs ?? 300_000);

    while (Date.now() < deadline) {
      const [run] = await this.options.db
        .select({ status: runs.status, output: runs.output, error: runs.error })
        .from(runs)
        .where(eq(runs.id, runId));

      if (run && (TERMINAL.has(run.status) || run.status === "waiting_approval")) return run;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.options.logger.warn({ runId }, "channel gave up waiting for a run");
    return undefined;
  }
}
