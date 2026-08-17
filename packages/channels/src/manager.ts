import type { Logger } from "@bridge/core";
import { agents, type Db, secrets } from "@bridge/db";
import type { SecretStore } from "@bridge/runtime";
import type { Channel } from "@bridge/sdk";
import { safeParseManifest } from "@bridge/spec";
import { and, eq } from "drizzle-orm";
import { ReliableChannel } from "./delivery.js";
import { DiscordChannel } from "./discord.js";
import { IMessageChannel } from "./imessage.js";
import { MatrixChannel } from "./matrix.js";
import { ChannelRunner } from "./runner.js";
import { SignalChannel } from "./signal.js";
import { SlackChannel } from "./slack.js";
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
  resolvedSecrets?: Record<string, string>,
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
  slack: (config, _token, logger, resolvedSecrets = {}) => {
    const appToken = resolvedSecrets.appTokenSecret;
    const botToken = resolvedSecrets.botTokenSecret;
    if (!appToken || !botToken) throw new Error("slack needs app and bot token secrets");
    return new SlackChannel({
      ...(config as { apiUrl?: string }),
      appToken,
      botToken,
      onError: (err) => logger.warn({ err }, "slack socket failed"),
    });
  },
  imessage: (config, _token, logger) =>
    new IMessageChannel({
      ...(config as { pollMs?: number }),
      onError: (err) => logger.warn({ err }, "iMessage poll failed"),
    }),
  signal: (config, _token, logger) =>
    new SignalChannel({
      ...(config as { account: string; command?: string; pollMs?: number }),
      onError: (err) => logger.warn({ err }, "Signal receive failed"),
    }),
  matrix: (config, _token, logger, resolvedSecrets = {}) => {
    const accessToken = resolvedSecrets.accessTokenSecret;
    if (!accessToken) throw new Error("Matrix needs an access token secret");
    return new MatrixChannel({
      ...(config as { homeserver: string; userId?: string }),
      accessToken,
      onError: (err) => logger.warn({ err }, "Matrix sync failed"),
    });
  },
};

export interface ChannelManagerOptions {
  db: Db;
  logger: Logger;
  secretStore: SecretStore;
  factories?: Record<string, ChannelFactory>;
  /** Overrides for ChannelRunner timings; tests use them, production does not. */
  runner?: { pollMs?: number; timeoutMs?: number };
  delivery?: { minIntervalMs?: number; maxAttempts?: number };
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
      .select({
        id: agents.id,
        workspaceId: agents.workspaceId,
        manifest: agents.manifest,
        updatedAt: agents.updatedAt,
      })
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
        const key = `${agent.id}:${binding.type}:${agent.updatedAt.getTime()}`;
        wanted.add(key);
        if (this.running.has(key)) continue;

        const factory = factories[binding.type];
        if (!factory) {
          logger.warn({ channel: binding.type }, "no adapter for this channel type");
          continue;
        }

        try {
          const resolvedSecrets = await this.resolveSecrets(agent.workspaceId, binding.config);
          const token = resolvedSecrets.tokenSecret;
          const channel = factory(binding.config, token, logger, resolvedSecrets);
          const runner = new ChannelRunner({
            db,
            logger,
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            channel: new ReliableChannel(channel, this.options.delivery),
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

  private async resolveSecrets(
    workspaceId: string,
    config: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!key.endsWith("Secret") || typeof value !== "string") continue;
      const token = await this.resolveNamedSecret(workspaceId, value);
      resolved[key] = token;
    }
    return resolved;
  }

  private async resolveNamedSecret(workspaceId: string, name: string): Promise<string> {
    const [row] = await this.options.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name)));
    if (!row) throw new Error(`no secret named "${name}" in this workspace`);
    const value = await this.options.secretStore.reveal(workspaceId, row.id);
    if (!value) throw new Error(`secret "${name}" is unavailable`);
    return value;
  }

  async stop(): Promise<void> {
    for (const runner of this.running.values()) await runner.stop().catch(() => undefined);
    this.running.clear();
  }
}
