import type { Logger } from "@bridge/core";
import { agents, type Db, secrets } from "@bridge/db";
import type { SecretStore } from "@bridge/runtime";
import type { Channel } from "@bridge/sdk";
import { safeParseManifest } from "@bridge/spec";
import { and, eq } from "drizzle-orm";
import { DiscordChannel } from "./discord.js";
import { ChannelRunner } from "./runner.js";
import { TelegramChannel } from "./telegram.js";

/**
 * Builds a channel adapter from a manifest binding.
 *
 * Bindings name a secret, never a token: a manifest is exported, shared and
 * moved between deployment targets, so a bot token in one would leak the
 * moment someone shared their agent.
 */
export type ChannelFactory = (
  config: Record<string, unknown>,
  token: string | undefined,
  logger: Logger,
) => Channel;

export const channelFactories: Record<string, ChannelFactory> = {
  telegram: (config, token, logger) => {
    if (!token) throw new Error("telegram needs a bot token secret");
    // Config spreads first: a manifest must not be able to override the
    // resolved secret with a token literal of its own.
    return new TelegramChannel({
      ...(config as { pollTimeoutSec?: number }),
      token,
      onError: (err) => logger.warn({ err }, "telegram poll failed"),
    });
  },
  discord: (config, token) => {
    if (!token) throw new Error("discord needs a bot token secret");
    return new DiscordChannel({ ...(config as { apiUrl?: string }), token });
  },
};

export interface ChannelManagerOptions {
  db: Db;
  logger: Logger;
  secretStore: SecretStore;
  factories?: Record<string, ChannelFactory>;
  /** Overrides for ChannelRunner timings; tests use them, production does not. */
  runner?: { pollMs?: number; timeoutMs?: number };
}

/**
 * Starts every channel bound by a deployed agent, and stops them all on
 * shutdown. Deploy/stop of an individual agent is picked up on the next
 * refresh rather than watched for.
 */
export class ChannelManager {
  private readonly running = new Map<string, ChannelRunner>();

  constructor(private readonly options: ChannelManagerOptions) {}

  /** Reconcile running channels with what deployed agents currently ask for. */
  async refresh(): Promise<void> {
    const { db, logger } = this.options;
    const factories = this.options.factories ?? channelFactories;

    const deployed = await db
      .select({ id: agents.id, workspaceId: agents.workspaceId, manifest: agents.manifest })
      .from(agents)
      .where(eq(agents.status, "deployed"));

    const wanted = new Set<string>();

    for (const agent of deployed) {
      const parsed = safeParseManifest(agent.manifest);
      if (!parsed.success) {
        logger.warn({ agent: agent.id }, "skipping channels: manifest does not parse");
        continue;
      }

      for (const binding of parsed.data.channels) {
        const key = `${agent.id}:${binding.type}`;
        wanted.add(key);
        if (this.running.has(key)) continue;

        const factory = factories[binding.type];
        if (!factory) {
          logger.warn({ channel: binding.type }, "no adapter for this channel type");
          continue;
        }

        try {
          const token = await this.resolveToken(agent.workspaceId, binding.config);
          const runner = new ChannelRunner({
            db,
            logger,
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            channel: factory(binding.config, token, logger),
            ...this.options.runner,
          });
          await runner.start();
          this.running.set(key, runner);
          logger.info({ agent: agent.id, channel: binding.type }, "channel started");
        } catch (error) {
          // One misconfigured bot token must not stop the other channels.
          logger.error(
            { agent: agent.id, channel: binding.type, err: error },
            "channel failed to start",
          );
        }
      }
    }

    for (const [key, runner] of this.running) {
      if (wanted.has(key)) continue;
      await runner.stop().catch(() => undefined);
      this.running.delete(key);
      logger.info({ channel: key }, "channel stopped");
    }
  }

  /** `config.tokenSecret` names a row in the secret store; we resolve it here. */
  private async resolveToken(
    workspaceId: string,
    config: Record<string, unknown>,
  ): Promise<string | undefined> {
    const name = config.tokenSecret;
    if (typeof name !== "string") return undefined;

    const [row] = await this.options.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name)));
    if (!row) throw new Error(`no secret named "${name}" in this workspace`);

    return this.options.secretStore.reveal(workspaceId, row.id);
  }

  async stop(): Promise<void> {
    for (const runner of this.running.values()) await runner.stop().catch(() => undefined);
    this.running.clear();
  }
}
