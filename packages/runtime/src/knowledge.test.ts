import { createLogger, newAgentId, newWorkspaceId } from "@bridge/core";
import {
  agents,
  createDb,
  type DbHandle,
  knowledgeEdges,
  knowledgeNodes,
  memoryEntries,
  workspaces,
} from "@bridge/db";
import type { CompletionRequest, Provider } from "@bridge/sdk";
import { personalAssistantTemplate, SPEC_VERSION } from "@bridge/spec";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeConsolidator, parseExtraction } from "./knowledge.js";

let handle: DbHandle;
let workspaceId: string;
let agentId: string;

const logger = createLogger("test");
logger.level = "silent";

/** Answers with whatever extraction the test wants, and records the prompt. */
function extractor(reply: unknown, seen: CompletionRequest[] = []): Provider {
  return {
    id: "anthropic",
    async complete(request) {
      seen.push(request);
      return {
        message: {
          role: "assistant",
          content: typeof reply === "string" ? reply : JSON.stringify(reply),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end",
      };
    },
  };
}

const journal = async (count: number, prefix = "turn") => {
  for (let i = 0; i < count; i += 1) {
    await handle.db.insert(memoryEntries).values({
      id: `mem_${prefix}_${i}_${Math.random().toString(36).slice(2)}`,
      workspaceId,
      agentId,
      kind: "knowledge",
      content: `User: ${prefix} ${i}\nAssistant: noted`,
    });
  }
};

const consolidator = (provider: Provider, options = {}) =>
  new KnowledgeConsolidator({
    db: handle.db,
    logger,
    getProvider: async () => provider,
    ...options,
  });

const nodes = () =>
  handle.db.select().from(knowledgeNodes).where(eq(knowledgeNodes.agentId, agentId));

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
}, 60_000);

afterEach(async () => {
  await handle?.close();
});

describe("when knowledge is consolidated", () => {
  it("waits for a batch instead of running after every message", async () => {
    const seen: CompletionRequest[] = [];
    const runner = consolidator(extractor({ nodes: [] }, seen), { batchSize: 8 });

    await journal(3);
    expect(await runner.tick()).toBe(0);
    expect(seen).toHaveLength(0);

    await journal(5, "more");
    await runner.tick();
    // One pass over the whole batch, not one per turn.
    expect(seen).toHaveLength(1);
  });

  it("runs anyway once the conversation has gone quiet", async () => {
    const seen: CompletionRequest[] = [];
    const runner = consolidator(extractor({ nodes: [] }, seen), {
      batchSize: 99,
      idleMs: 60_000,
      // An hour later, nothing more has been said.
      now: () => new Date(Date.now() + 3_600_000),
    });

    await journal(2);
    await runner.tick();
    expect(seen).toHaveLength(1);
  });
});

describe("what consolidation produces", () => {
  it("writes nodes and the links between them", async () => {
    const runner = consolidator(
      extractor({
        nodes: [
          {
            title: "Lucas",
            kind: "person",
            body: "Builds Bridge.",
            confidence: 0.9,
            links: [{ to: "Bridge", relation: "works on" }],
          },
          { title: "Bridge", kind: "project", body: "An agent operating system." },
        ],
      }),
      { batchSize: 1 },
    );

    await journal(2);
    await runner.tick();

    const saved = await nodes();
    expect(saved.map((node) => node.title).sort()).toEqual(["Bridge", "Lucas"]);
    expect(saved.find((node) => node.title === "Lucas")).toMatchObject({
      kind: "person",
      confidence: "0.90",
      mentions: 1,
    });

    const edges = await handle.db.select().from(knowledgeEdges);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.relation).toBe("works on");
  });

  it("updates what it already knows rather than saying it twice", async () => {
    const first = consolidator(
      extractor({ nodes: [{ title: "Lucas", kind: "person", body: "Builds things." }] }),
      { batchSize: 1 },
    );
    await journal(1, "a");
    await first.tick();

    const second = consolidator(
      extractor({
        nodes: [{ title: "Lucas", kind: "person", body: "Builds Bridge, in TypeScript." }],
      }),
      { batchSize: 1 },
    );
    await journal(1, "b");
    await second.tick();

    const saved = await nodes();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      body: "Builds Bridge, in TypeScript.",
      // Seen twice now, which is what confidence is built from.
      mentions: 2,
    });
  });

  it("shows the model what is already known, so it can merge", async () => {
    const seen: CompletionRequest[] = [];
    await journal(1, "a");
    await consolidator(extractor({ nodes: [{ title: "Lucas", kind: "person", body: "A." }] }), {
      batchSize: 1,
    }).tick();

    await journal(1, "b");
    await consolidator(extractor({ nodes: [] }, seen), { batchSize: 1 }).tick();

    expect(seen[0]?.messages.at(-1)?.content).toContain("Lucas");
  });

  it("reads each turn once, even when nothing came of it", async () => {
    const seen: CompletionRequest[] = [];
    const runner = consolidator(extractor({ nodes: [] }, seen), { batchSize: 1 });

    await journal(2);
    await runner.tick();
    await runner.tick();

    // The second pass has nothing left to read.
    expect(seen).toHaveLength(1);
    const unread = await handle.db
      .select()
      .from(memoryEntries)
      .where(and(eq(memoryEntries.agentId, agentId), eq(memoryEntries.kind, "knowledge")));
    expect(unread.every((entry) => entry.consolidatedAt !== null)).toBe(true);
  });

  it("survives a model that does not answer in JSON", async () => {
    const runner = consolidator(extractor("I'm afraid I can't do that."), { batchSize: 1 });
    await journal(1);
    await expect(runner.tick()).resolves.toBe(0);
    expect(await nodes()).toHaveLength(0);
  });
});

describe("reading the model's answer", () => {
  it("takes JSON out of a fenced block, and ignores prose around it", () => {
    const parsed = parseExtraction(
      'Here is what I found:\n```json\n{"nodes":[{"title":"A","body":"B"}]}\n```\nHope that helps.',
    );
    expect(parsed).toEqual([{ title: "A", body: "B", kind: "fact", links: [] }]);
  });

  it("drops entries that are not usable rather than failing", () => {
    expect(parseExtraction('{"nodes":[{"title":"","body":"x"},{"body":"no title"},3]}')).toEqual(
      [],
    );
    expect(parseExtraction("not json at all")).toEqual([]);
    expect(parseExtraction('{"nodes":"nope"}')).toEqual([]);
  });
});
