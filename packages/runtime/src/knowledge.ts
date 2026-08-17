import { id, type Logger } from "@bridge/core";
import {
  agents,
  type Db,
  knowledgeEdges,
  knowledgeNodes,
  memoryEntries,
  workspaces,
} from "@bridge/db";
import type { Provider } from "@bridge/sdk";
import { parseManifest } from "@bridge/spec";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * Turning what was said into what is known.
 *
 * The journal (`memory_entries`) is written cheaply after every turn, because
 * losing a conversation you cannot get back is worse than storing too much.
 * Understanding it is a separate act, and a slower one: it re-reads a stretch
 * of conversation at once, decides what actually mattered, and folds that into
 * a graph of facts that already exist — merging with what is known rather than
 * appending another row.
 *
 * Doing that per message was the mistake it replaces. Every message became a
 * "memory", so nothing was: the same fact restated four ways, no links between
 * anything, and a page that grew without ever getting wiser. Consolidation
 * waits for enough new material or a long enough pause, which is also when a
 * person would think back over a conversation rather than during it.
 */
export interface KnowledgeOptions {
  db: Db;
  logger: Logger;
  getProvider(workspaceId: string, providerId: string): Promise<Provider>;
  /** Turns of raw journal that trigger a pass on their own. */
  batchSize?: number;
  /** A quiet stretch that ends a session, so it is thought over. */
  idleMs?: number;
  pollMs?: number;
  now?: () => Date;
}

export interface ExtractedNode {
  title: string;
  kind: string;
  body: string;
  confidence?: number;
  /** Titles of other nodes this one relates to, and how. */
  links?: { to: string; relation?: string }[];
}

const KINDS = new Set(["person", "project", "preference", "fact", "event"]);

const INSTRUCTIONS = `You maintain an agent's long-term knowledge graph.

Read the conversation excerpts and return what is worth remembering *permanently*
— things that will still be true and still matter next week.

Return JSON only, in this shape:
{"nodes":[{"title":"short name","kind":"person|project|preference|fact|event",
"body":"one or two sentences, written as standing fact","confidence":0.0-1.0,
"links":[{"to":"title of another node","relation":"works on"}]}]}

Rules:
- Merge, do not duplicate. If an existing node covers it, reuse its exact title
  and give the improved body; it will be updated rather than added.
- Skip pleasantries, one-off task instructions, and anything already obvious
  from the agent's own configuration.
- Prefer few good nodes to many weak ones. Returning {"nodes":[]} is correct
  when nothing durable was said.
- Link nodes to each other wherever a relationship exists. A graph of isolated
  points is a list.`;

/** Rows the model is asked to reconcile against, kept small on purpose. */
interface ExistingNode {
  id: string;
  title: string;
  kind: string;
  body: string;
}

export class KnowledgeConsolidator {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly options: KnowledgeOptions) {}

  private get now(): Date {
    return this.options.now?.() ?? new Date();
  }

  start(): void {
    const poll = this.options.pollMs ?? 60_000;
    this.timer = setInterval(() => void this.safeTick(), poll);
    this.timer.unref?.();
    void this.safeTick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (error) {
      this.options.logger.error({ err: error }, "knowledge consolidation failed");
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass over every agent with unconsolidated turns. An agent qualifies
   * when it has said enough since the last pass, or when it has stopped
   * talking for a while — whichever comes first.
   */
  async tick(): Promise<number> {
    const batchSize = this.options.batchSize ?? 8;
    const idleMs = this.options.idleMs ?? 10 * 60 * 1000;

    const pending = await this.options.db
      .select({
        workspaceId: memoryEntries.workspaceId,
        agentId: memoryEntries.agentId,
        turns: sql<number>`count(*)::int`,
        newest: sql<Date>`max(${memoryEntries.createdAt})`,
      })
      .from(memoryEntries)
      .where(isNull(memoryEntries.consolidatedAt))
      .groupBy(memoryEntries.workspaceId, memoryEntries.agentId);

    let consolidated = 0;
    for (const group of pending) {
      const quiet = this.now.getTime() - new Date(group.newest).getTime() >= idleMs;
      if (group.turns < batchSize && !quiet) continue;
      consolidated += (await this.consolidate(group.workspaceId, group.agentId)) ? 1 : 0;
    }
    return consolidated;
  }

  /** Read one agent's outstanding journal into its graph. */
  async consolidate(workspaceId: string, agentId: string): Promise<boolean> {
    const journal = await this.options.db
      .select({ id: memoryEntries.id, content: memoryEntries.content })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.workspaceId, workspaceId),
          eq(memoryEntries.agentId, agentId),
          isNull(memoryEntries.consolidatedAt),
        ),
      )
      .orderBy(asc(memoryEntries.createdAt))
      .limit(40);
    if (journal.length === 0) return false;

    const existing = await this.options.db
      .select({
        id: knowledgeNodes.id,
        title: knowledgeNodes.title,
        kind: knowledgeNodes.kind,
        body: knowledgeNodes.body,
      })
      .from(knowledgeNodes)
      .where(and(eq(knowledgeNodes.workspaceId, workspaceId), eq(knowledgeNodes.agentId, agentId)))
      .orderBy(desc(knowledgeNodes.updatedAt))
      .limit(60);

    const extracted = await this.extract(workspaceId, agentId, journal, existing);

    // Mark the journal read whatever came back: a pass that found nothing
    // worth keeping is a completed pass, not one to repeat forever.
    await this.options.db
      .update(memoryEntries)
      .set({ consolidatedAt: this.now })
      .where(
        inArray(
          memoryEntries.id,
          journal.map((entry) => entry.id),
        ),
      );

    if (extracted.length === 0) return false;
    await this.merge(workspaceId, agentId, extracted, existing);
    this.options.logger.info(
      { agentId, turns: journal.length, nodes: extracted.length },
      "knowledge consolidated",
    );
    return true;
  }

  /** Ask the agent's own model what mattered. */
  private async extract(
    workspaceId: string,
    agentId: string,
    journal: { content: string }[],
    existing: ExistingNode[],
  ): Promise<ExtractedNode[]> {
    const [agent] = await this.options.db
      .select({ manifest: agents.manifest })
      .from(agents)
      .where(eq(agents.id, agentId));
    if (!agent) return [];

    /**
     * The workspace default wins, exactly as it does for a run.
     *
     * Reading the manifest alone sent consolidation to whichever provider the
     * template happened to name — anthropic, on an install that only ever
     * connected OpenAI — so every pass failed with "provider not connected"
     * and the graph silently stayed empty.
     */
    const [workspace] = await this.options.db
      .select({ defaultModel: workspaces.defaultModel })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    const manifest = parseManifest(agent.manifest);
    const model = workspace?.defaultModel ?? manifest.models.default;
    const provider = await this.options.getProvider(workspaceId, model.provider);

    const known = existing.length
      ? `Already known (reuse these titles to update them):\n${existing
          .map((node) => `- ${node.title} [${node.kind}]: ${node.body}`)
          .join("\n")}`
      : "Nothing is known about this yet.";

    const result = await provider.complete({
      model: model.model,
      // Cheap and mechanical: this is extraction, not conversation.
      ...(model.provider === "anthropic" ? {} : { temperature: 0 }),
      messages: [
        { role: "system", content: INSTRUCTIONS },
        {
          role: "user",
          content: `${known}\n\nConversation excerpts:\n\n${journal
            .map((entry) => entry.content)
            .join("\n\n---\n\n")
            .slice(0, 24_000)}`,
        },
      ],
    });

    return parseExtraction(result.message.content);
  }

  /**
   * Fold the extraction into the graph.
   *
   * A node whose title already exists is updated in place and gains a mention
   * rather than becoming a second row — that is what stops the graph filling
   * with restatements of the same fact.
   */
  private async merge(
    workspaceId: string,
    agentId: string,
    extracted: ExtractedNode[],
    existing: ExistingNode[],
  ): Promise<void> {
    const byTitle = new Map(existing.map((node) => [node.title.toLowerCase(), node]));
    const ids = new Map<string, string>();

    for (const node of extracted) {
      const match = byTitle.get(node.title.toLowerCase());
      const confidence = clamp(node.confidence ?? 0.6);
      if (match) {
        await this.options.db
          .update(knowledgeNodes)
          .set({
            body: node.body,
            kind: KINDS.has(node.kind) ? node.kind : "fact",
            confidence: confidence.toFixed(2),
            mentions: sql`${knowledgeNodes.mentions} + 1`,
            updatedAt: this.now,
          })
          .where(eq(knowledgeNodes.id, match.id));
        ids.set(node.title.toLowerCase(), match.id);
        continue;
      }

      const nodeId = id("kno");
      await this.options.db.insert(knowledgeNodes).values({
        id: nodeId,
        workspaceId,
        agentId,
        title: node.title.slice(0, 120),
        kind: KINDS.has(node.kind) ? node.kind : "fact",
        body: node.body,
        confidence: confidence.toFixed(2),
      });
      ids.set(node.title.toLowerCase(), nodeId);
    }

    for (const node of extracted) {
      const fromId = ids.get(node.title.toLowerCase());
      if (!fromId) continue;
      for (const link of node.links ?? []) {
        const toId = ids.get(link.to.toLowerCase()) ?? byTitle.get(link.to.toLowerCase())?.id;
        if (!toId || toId === fromId) continue;
        await this.options.db
          .insert(knowledgeEdges)
          .values({
            id: id("kne"),
            workspaceId,
            fromId,
            toId,
            relation: (link.relation ?? "related to").slice(0, 60),
          })
          .onConflictDoNothing();
      }
    }
  }
}

const clamp = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.6));

/**
 * Models wrap JSON in prose and fences however they feel. Pull out the object
 * and ignore anything malformed — a bad extraction should cost one pass, not
 * throw inside a background loop.
 */
export function parseExtraction(content: string): ExtractedNode[] {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? content).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { nodes?: unknown };
    if (!Array.isArray(parsed.nodes)) return [];
    return parsed.nodes
      .filter(
        (node): node is ExtractedNode =>
          typeof node === "object" &&
          node !== null &&
          typeof (node as ExtractedNode).title === "string" &&
          typeof (node as ExtractedNode).body === "string" &&
          (node as ExtractedNode).title.trim().length > 0,
      )
      .map((node) => ({
        ...node,
        title: node.title.trim(),
        kind: typeof node.kind === "string" ? node.kind : "fact",
        links: Array.isArray(node.links)
          ? node.links.filter((link) => typeof link?.to === "string")
          : [],
      }))
      .slice(0, 25);
  } catch {
    return [];
  }
}
