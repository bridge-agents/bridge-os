import { createHmac, timingSafeEqual } from "node:crypto";
import { processChannelMessage } from "@bridge/channels";
import { BridgeError } from "@bridge/core";
import { agents } from "@bridge/db";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import { safeParseManifest } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./http.js";

interface WhatsAppConfig {
  phoneNumberId: string;
  accessTokenSecret: string;
  verifyTokenSecret: string;
  appSecretSecret: string;
}

export function channelWebhookRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = new EncryptedDbSecretStore(deps.db, deps.secretKey);

  const resolve = async (agentId: string) => {
    const [agent] = await deps.db.select().from(agents).where(eq(agents.id, agentId));
    if (agent?.status !== "deployed") {
      throw new BridgeError("not_found", "deployed channel agent not found");
    }
    const manifest = safeParseManifest(agent.manifest);
    const binding = manifest.success
      ? manifest.data.channels.find((entry) => entry.type === "whatsapp")
      : undefined;
    if (!binding) throw new BridgeError("not_found", "WhatsApp binding not found");
    const config = binding.config as unknown as WhatsAppConfig;
    const [accessToken, verifyToken, appSecret] = await Promise.all([
      store.revealNamed(agent.workspaceId, config.accessTokenSecret),
      store.revealNamed(agent.workspaceId, config.verifyTokenSecret),
      store.revealNamed(agent.workspaceId, config.appSecretSecret),
    ]);
    if (!accessToken || !verifyToken || !appSecret || !config.phoneNumberId) {
      throw new BridgeError("not_found", "WhatsApp credentials are incomplete");
    }
    return { agent, config, accessToken, verifyToken, appSecret };
  };

  app.get("/whatsapp/:agentId/webhook", async (c) => {
    const channel = await resolve(c.req.param("agentId"));
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode !== "subscribe" || token !== channel.verifyToken || !challenge) {
      throw new BridgeError("forbidden", "WhatsApp webhook verification failed");
    }
    return c.text(challenge);
  });

  app.post("/whatsapp/:agentId/webhook", async (c) => {
    const channel = await resolve(c.req.param("agentId"));
    const raw = await c.req.text();
    const expected = `sha256=${createHmac("sha256", channel.appSecret).update(raw).digest("hex")}`;
    const provided = c.req.header("x-hub-signature-256") ?? "";
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      throw new BridgeError("unauthorized", "WhatsApp webhook signature is invalid");
    }
    const payload = JSON.parse(raw) as {
      entry?: {
        changes?: {
          value?: { messages?: { from?: string; type?: string; text?: { body?: string } }[] };
        }[];
      }[];
    };
    const messages = (payload.entry ?? []).flatMap((entry) =>
      (entry.changes ?? []).flatMap((change) => change.value?.messages ?? []),
    );
    void Promise.all(
      messages.flatMap((message) =>
        message.from && message.type === "text" && message.text?.body
          ? [
              processChannelMessage(
                {
                  db: deps.db,
                  logger: deps.logger,
                  workspaceId: channel.agent.workspaceId,
                  agentId: channel.agent.id,
                  channel: { type: "whatsapp" },
                },
                {
                  channel: "whatsapp",
                  senderId: message.from,
                  text: message.text.body,
                  raw: message,
                },
              ).then((reply) => sendWhatsAppReply(channel, message.from as string, reply)),
            ]
          : [],
      ),
    ).catch((error) => deps.logger.error({ err: error }, "WhatsApp message failed"));
    return c.json({ received: true });
  });

  return app;
}

async function sendWhatsAppReply(
  channel: { config: WhatsAppConfig; accessToken: string },
  recipient: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${encodeURIComponent(channel.config.phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${channel.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { preview_url: false, body: text.slice(0, 4096) },
      }),
    },
  );
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status})`);
}
