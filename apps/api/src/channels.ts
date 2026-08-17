import { BridgeError } from "@bridge/core";
import { agents, secrets } from "@bridge/db";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import { safeParseManifest } from "@bridge/spec";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

interface ChannelConnectorDefinition {
  type: string;
  name: string;
  description: string;
  status: "available" | "requires-webhook" | "requires-native-helper" | "planned";
  fields: {
    key: string;
    secretKey?: string;
    configKey?: string;
    label: string;
    placeholder: string;
  }[];
}

const CHANNEL_CATALOG: ChannelConnectorDefinition[] = [
  {
    type: "telegram",
    name: "Telegram",
    description: "Long-polling bot connection for direct chats and groups.",
    status: "available",
    fields: [
      { key: "token", secretKey: "tokenSecret", label: "Bot token", placeholder: "123456:ABC..." },
    ],
  },
  {
    type: "discord",
    name: "Discord",
    description: "Gateway bot connection for servers and direct messages.",
    status: "available",
    fields: [
      {
        key: "token",
        secretKey: "tokenSecret",
        label: "Bot token",
        placeholder: "Discord bot token",
      },
    ],
  },
  {
    type: "slack",
    name: "Slack",
    description: "Socket Mode connection that works without a public webhook URL.",
    status: "available",
    fields: [
      { key: "appToken", secretKey: "appTokenSecret", label: "App token", placeholder: "xapp-..." },
      { key: "botToken", secretKey: "botTokenSecret", label: "Bot token", placeholder: "xoxb-..." },
    ],
  },
  {
    type: "whatsapp",
    name: "WhatsApp",
    description: "Meta Cloud API with a verified public Bridge webhook.",
    status: "available",
    fields: [
      {
        key: "phoneNumberId",
        configKey: "phoneNumberId",
        label: "Phone number ID",
        placeholder: "Meta phone number ID",
      },
      {
        key: "accessToken",
        secretKey: "accessTokenSecret",
        label: "Access token",
        placeholder: "Permanent system-user token",
      },
      {
        key: "verifyToken",
        secretKey: "verifyTokenSecret",
        label: "Webhook verify token",
        placeholder: "Choose a private verification token",
      },
      {
        key: "appSecret",
        secretKey: "appSecretSecret",
        label: "Meta app secret",
        placeholder: "Meta app secret",
      },
    ],
  },
  {
    type: "imessage",
    name: "iMessage",
    description: "Uses Messages on this Mac with Full Disk Access and Automation permission.",
    status: process.platform === "darwin" ? "available" : "requires-native-helper",
    fields: [],
  },
  {
    type: "microsoft-teams",
    name: "Microsoft Teams",
    description: "Requires a Microsoft Bot Framework application and public callback.",
    status: "requires-webhook",
    fields: [],
  },
  {
    type: "signal",
    name: "Signal",
    description: "Uses a linked signal-cli account on the Bridge host.",
    status: "available",
    fields: [
      {
        key: "account",
        configKey: "account",
        label: "Signal account",
        placeholder: "+61400000000",
      },
    ],
  },
  {
    type: "matrix",
    name: "Matrix",
    description: "Matrix Client-Server sync connection for rooms and direct messages.",
    status: "available",
    fields: [
      {
        key: "homeserver",
        configKey: "homeserver",
        label: "Homeserver URL",
        placeholder: "https://matrix.example.com",
      },
      {
        key: "userId",
        configKey: "userId",
        label: "Bot user ID",
        placeholder: "@bridge:example.com",
      },
      {
        key: "accessToken",
        secretKey: "accessTokenSecret",
        label: "Access token",
        placeholder: "Matrix access token",
      },
    ],
  },
];

const AVAILABLE = CHANNEL_CATALOG.filter((connector) => connector.status === "available");
const ConnectSchema = z.object({
  agentId: z.string().min(1),
  credentials: z.record(z.string(), z.string().min(1).max(8192)),
});

export function channelRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const store = new EncryptedDbSecretStore(deps.db, deps.secretKey);
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const workspaceId = c.get("workspaceId");
    const rows = await deps.db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        manifest: agents.manifest,
      })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(desc(agents.updatedAt));
    const secretRefs = await store.list(workspaceId);
    const hints = new Map(secretRefs.map((secret) => [secret.name, secret.hint]));

    const bindings = rows.flatMap((agent) => {
      const manifest = safeParseManifest(agent.manifest);
      if (!manifest.success) return [];
      return manifest.data.channels.map((binding) => ({
        agentId: agent.id,
        agentName: agent.name,
        agentStatus: agent.status,
        type: binding.type,
        credentials: Object.fromEntries(
          Object.entries(binding.config).flatMap(([key, value]) =>
            key.endsWith("Secret") && typeof value === "string"
              ? [[key, { name: value, hint: hints.get(value) ?? null }]]
              : [],
          ),
        ),
      }));
    });
    return c.json({ connectors: CHANNEL_CATALOG, bindings });
  });

  app.put("/:type", requireRole("owner", "admin"), async (c) => {
    const type = c.req.param("type");
    const body = await parseBody(c, ConnectSchema);
    const workspaceId = c.get("workspaceId");
    const connector = AVAILABLE.find((entry) => entry.type === type);
    if (!connector) throw new BridgeError("not_found", "channel connector not found");

    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, body.agentId)));
    if (!agent) throw new BridgeError("not_found", "agent not found");
    const parsed = safeParseManifest(agent.manifest);
    if (!parsed.success) throw new BridgeError("validation_failed", "agent manifest is invalid");

    const config: Record<string, string> = {};
    for (const field of connector.fields) {
      const value = body.credentials[field.key];
      if (!value) {
        throw new BridgeError("validation_failed", `${field.label} is required`);
      }
      if (field.secretKey) {
        const secretName = channelSecretName(type, agent.id, field.key);
        await store.put(workspaceId, secretName, value);
        config[field.secretKey] = secretName;
      } else {
        config[field.configKey ?? field.key] = value;
      }
    }

    const manifest = {
      ...parsed.data,
      channels: [
        ...parsed.data.channels.filter((binding) => binding.type !== type),
        { type, config },
      ],
    };
    await deps.db
      .update(agents)
      .set({ manifest, updatedAt: new Date() })
      .where(eq(agents.id, agent.id));
    return c.json({ binding: { agentId: agent.id, agentName: agent.name, type } }, 201);
  });

  app.delete("/:type/:agentId", requireRole("owner", "admin"), async (c) => {
    const workspaceId = c.get("workspaceId");
    const type = c.req.param("type");
    const [agent] = await deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, c.req.param("agentId"))));
    if (!agent) throw new BridgeError("not_found", "agent not found");
    const parsed = safeParseManifest(agent.manifest);
    if (!parsed.success) throw new BridgeError("validation_failed", "agent manifest is invalid");
    const binding = parsed.data.channels.find((entry) => entry.type === type);
    if (!binding) throw new BridgeError("not_found", "channel binding not found");

    for (const value of Object.values(binding.config)) {
      if (typeof value !== "string") continue;
      const [row] = await deps.db
        .select({ id: secrets.id })
        .from(secrets)
        .where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, value)));
      if (row) await store.delete(workspaceId, row.id);
    }
    await deps.db
      .update(agents)
      .set({
        manifest: {
          ...parsed.data,
          channels: parsed.data.channels.filter((entry) => entry.type !== type),
        },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id));
    return c.body(null, 204);
  });

  return app;
}

function channelSecretName(type: string, agentId: string, key: string): string {
  return `channel_${type}_${agentId}_${key}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 128);
}
