import {
  createLogger,
  generateSecretKey,
  newAgentId,
  newWorkspaceId,
  parseSecretKey,
} from "@bridge/core";
import { agents, conversations, createDb, type DbHandle, runs, workspaces } from "@bridge/db";
import { EncryptedDbSecretStore } from "@bridge/runtime";
import type { Channel, InboundMessage, OutboundMessage } from "@bridge/sdk";
import { personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReliableChannel } from "./delivery.js";
import { ChannelManager } from "./manager.js";
import { ChannelRunner } from "./runner.js";
import { SlackChannel } from "./slack.js";
import { TelegramChannel } from "./telegram.js";

let handle: DbHandle;
let workspaceId: string;
let agentId: string;

const logger = createLogger("test");
logger.level = "silent";

/** A channel we can drive by hand, standing in for Telegram or Discord. */
class FakeChannel implements Channel {
  readonly type = "fake";
  readonly sent: OutboundMessage[] = [];
  private handler?: (message: InboundMessage) => Promise<void>;

  async start(onMessage: (message: InboundMessage) => Promise<void>) {
    this.handler = onMessage;
  }
  async send(message: OutboundMessage) {
    this.sent.push(message);
  }
  async stop() {
    this.handler = undefined;
  }
  receive(text: string, senderId = "42") {
    return this.handler?.({ channel: this.type, senderId, text });
  }
}

/** Pretend the executor finished the run, so the runner can be tested alone. */
function finish(status: string, output?: unknown, error?: string) {
  return handle.db.update(runs).set({ status, output, error }).where(eq(runs.status, "queued"));
}

beforeEach(async () => {
  handle = await createDb("pglite:memory");
  await handle.migrate();

  workspaceId = newWorkspaceId();
  agentId = newAgentId();
  await handle.db.insert(workspaces).values({ id: workspaceId, name: "Test" });
  await handle.db.insert(agents).values({
    id: agentId,
    workspaceId,
    name: "Assistant",
    slug: "assistant",
    specVersion: SPEC_VERSION,
    manifest: personalAssistantTemplate.manifest,
    status: "deployed",
  });
});

afterEach(() => handle.close());

function runner(channel: Channel) {
  return new ChannelRunner({
    db: handle.db,
    logger,
    workspaceId,
    agentId,
    channel,
    pollMs: 5,
    timeoutMs: 2_000,
  });
}

describe("ReliableChannel", () => {
  it("retries transient delivery failures and serializes concurrent sends", async () => {
    const delivered: string[] = [];
    let attempts = 0;
    const inner: Channel = {
      type: "retrying",
      async start() {},
      async stop() {},
      async send(message) {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary rate limit");
        delivered.push(message.text);
      },
    };
    const channel = new ReliableChannel(inner, { minIntervalMs: 0, maxAttempts: 3 });

    await Promise.all([
      channel.send({ recipientId: "1", text: "first" }),
      channel.send({ recipientId: "1", text: "second" }),
    ]);

    expect(attempts).toBe(3);
    expect(delivered).toEqual(["first", "second"]);
  });
});

describe("ChannelRunner", () => {
  it("turns an inbound message into a run and replies with its output", async () => {
    const channel = new FakeChannel();
    await runner(channel).start();

    const inbound = channel.receive("what is a bridge?");
    // The run only completes because we stand in for the executor here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await finish("succeeded", { content: "a path across a gap" });
    await inbound;

    expect(channel.sent).toEqual([{ recipientId: "42", text: "a path across a gap" }]);

    const [run] = await handle.db.select().from(runs);
    expect(run?.trigger).toBe("channel");
    expect(run?.input).toEqual({ text: "what is a bridge?" });
  });

  it("keeps one conversation per sender so the agent remembers the thread", async () => {
    const channel = new FakeChannel();
    const bound = runner(channel);
    await bound.start();

    for (const text of ["first", "second"]) {
      const inbound = channel.receive(text);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await finish("succeeded", { content: `re: ${text}` });
      await inbound;
    }

    const threads = await handle.db.select().from(conversations);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.externalId).toBe("fake:42");

    const all = await handle.db.select({ conversationId: runs.conversationId }).from(runs);
    expect(new Set(all.map((run) => run.conversationId)).size).toBe(1);
  });

  it("gives different senders separate conversations", async () => {
    const channel = new FakeChannel();
    await runner(channel).start();

    for (const sender of ["1", "2"]) {
      const inbound = channel.receive("hello", sender);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await finish("succeeded", { content: "hi" });
      await inbound;
    }

    const threads = await handle.db.select().from(conversations);
    expect(threads.map((thread) => thread.externalId).sort()).toEqual(["fake:1", "fake:2"]);
  });

  it("tells the sender when a run parks for approval instead of going silent", async () => {
    const channel = new FakeChannel();
    await runner(channel).start();

    const inbound = channel.receive("delete everything");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await finish("waiting_approval");
    await inbound;

    expect(channel.sent[0]?.text).toContain("approval");
  });

  it("reports a failure rather than dropping the message", async () => {
    const channel = new FakeChannel();
    await runner(channel).start();

    const inbound = channel.receive("break");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await finish("failed", null, "provider exploded");
    await inbound;

    expect(channel.sent[0]?.text).toContain("provider exploded");
  });
});

describe("ChannelManager", () => {
  async function withBinding(config: Record<string, unknown>) {
    const manifest = structuredClone(personalAssistantTemplate.manifest) as Record<string, unknown>;
    manifest.channels = [{ type: "fake", config }];
    await handle.db.update(agents).set({ manifest }).where(eq(agents.id, agentId));
  }

  const secretStore = () =>
    new EncryptedDbSecretStore(handle.db, parseSecretKey(generateSecretKey()));

  it("starts a channel for each binding on a deployed agent", async () => {
    await withBinding({ tokenSecret: "bot" });
    const store = secretStore();
    await store.put(workspaceId, "bot", "token-123");

    let seenToken: string | undefined;
    const channel = new FakeChannel();
    const manager = new ChannelManager({
      db: handle.db,
      logger,
      secretStore: store,
      runner: { pollMs: 5, timeoutMs: 50 },
      factories: {
        fake: (_config: Record<string, unknown>, token: string | undefined) => {
          seenToken = token;
          return channel;
        },
      },
    });

    await manager.refresh();
    expect(seenToken).toBe("token-123");

    // Refreshing again must not start a second copy of the same channel.
    await manager.refresh();
    await channel.receive("hi");
    // One runner, so one queued run — a duplicate start would produce two.
    expect(await handle.db.select().from(runs)).toHaveLength(1);
    await manager.stop();
  });

  it("stops a channel when its agent is no longer deployed", async () => {
    await withBinding({ tokenSecret: "bot" });
    const store = secretStore();
    await store.put(workspaceId, "bot", "token-123");

    let stopped = false;
    const manager = new ChannelManager({
      db: handle.db,
      logger,
      secretStore: store,
      factories: {
        fake: () => {
          const channel = new FakeChannel();
          const stop = channel.stop.bind(channel);
          channel.stop = async () => {
            stopped = true;
            return stop();
          };
          return channel;
        },
      },
    });

    await manager.refresh();
    await handle.db.update(agents).set({ status: "stopped" }).where(eq(agents.id, agentId));
    await manager.refresh();

    expect(stopped).toBe(true);
  });

  it("survives a binding whose secret is missing", async () => {
    await withBinding({ tokenSecret: "absent" });
    const manager = new ChannelManager({
      db: handle.db,
      logger,
      secretStore: secretStore(),
      factories: { fake: () => new FakeChannel() },
    });

    await expect(manager.refresh()).resolves.toBeUndefined();
  });
});

describe("SlackChannel", () => {
  it("acks Socket Mode events and replies through chat.postMessage", async () => {
    const sentFrames: string[] = [];
    const listeners = new Map<string, ((event: { data?: string }) => void)[]>();
    const socket = {
      addEventListener(type: string, listener: (event: { data?: string }) => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      send(value: string) {
        sentFrames.push(value);
      },
      close() {},
    } as unknown as WebSocket;
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      if (url.endsWith("apps.connections.open")) {
        return Response.json({ ok: true, url: "wss://slack.test/socket" });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const inbound: InboundMessage[] = [];
    const channel = new SlackChannel({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      fetchImpl,
      socketFactory: () => socket,
    });
    await channel.start(async (message) => void inbound.push(message));

    const message = JSON.stringify({
      envelope_id: "env-1",
      type: "events_api",
      payload: { event: { type: "message", channel: "C123", text: "hello" } },
    });
    for (const listener of listeners.get("message") ?? []) listener({ data: message });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentFrames).toEqual([JSON.stringify({ envelope_id: "env-1" })]);
    expect(inbound[0]).toMatchObject({ channel: "slack", senderId: "C123", text: "hello" });

    await channel.send({ recipientId: "C123", text: "reply" });
    expect(calls.at(-1)).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "reply" },
    });
    await channel.stop();
  });
});

describe("TelegramChannel", () => {
  it("polls for updates, hands over the text, and answers the same chat", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });

      if (method === "getUpdates" && calls.filter((c) => c.method === "getUpdates").length === 1) {
        return Response.json({
          ok: true,
          result: [{ update_id: 7, message: { text: "hello", chat: { id: 99 } } }],
        });
      }
      if (method === "getUpdates") return Response.json({ ok: true, result: [] });
      return Response.json({ ok: true, result: {} });
    }) as unknown as typeof fetch;

    const channel = new TelegramChannel({ token: "t", fetchImpl, pollTimeoutSec: 0 });
    const received: InboundMessage[] = [];
    await channel.start(async (message) => void received.push(message));

    await new Promise((resolve) => setTimeout(resolve, 30));
    await channel.stop();

    expect(received[0]).toMatchObject({ channel: "telegram", senderId: "99", text: "hello" });
    // The next poll must not replay the update we already handled.
    expect(calls.filter((call) => call.method === "getUpdates").at(-1)?.body.offset).toBe(8);

    await channel.send({ recipientId: "99", text: "hi back" });
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: { chat_id: "99", text: "hi back" },
    });
  });

  it("splits a reply that exceeds Telegram's message limit", async () => {
    const sends: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("sendMessage")) {
        sends.push(String(JSON.parse(String(init?.body)).text));
      }
      return Response.json({ ok: true, result: {} });
    }) as unknown as typeof fetch;

    const channel = new TelegramChannel({ token: "t", fetchImpl });
    await channel.send({ recipientId: "1", text: "x".repeat(4097) });

    expect(sends.map((text) => text.length)).toEqual([4096, 1]);
  });
});
