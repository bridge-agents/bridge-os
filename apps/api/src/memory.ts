import { BridgeError, id } from "@bridge/core";
import { agents, knowledgeEdges, knowledgeNodes, memoryEntries } from "@bridge/db";
import { and, desc, eq, ilike } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

export function memoryRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const agentId = c.req.query("agentId");
    const kind = c.req.query("kind");
    const query = c.req.query("q")?.trim();
    const rows = await deps.db
      .select({
        id: memoryEntries.id,
        agentId: memoryEntries.agentId,
        agentName: agents.name,
        runId: memoryEntries.runId,
        kind: memoryEntries.kind,
        content: memoryEntries.content,
        createdAt: memoryEntries.createdAt,
      })
      .from(memoryEntries)
      .innerJoin(agents, eq(agents.id, memoryEntries.agentId))
      .where(
        and(
          eq(memoryEntries.workspaceId, c.get("workspaceId")),
          ...(agentId ? [eq(memoryEntries.agentId, agentId)] : []),
          ...(kind ? [eq(memoryEntries.kind, kind)] : []),
          ...(query ? [ilike(memoryEntries.content, `%${query}%`)] : []),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(200);
    return c.json({ memories: rows });
  });

  app.post("/", requireRole("owner", "admin"), async (c) => {
    const body = await parseBody(
      c,
      z.object({
        agentId: z.string().min(1),
        content: z.string().trim().min(1).max(20_000),
        kind: z.enum(["long-term", "knowledge"]).default("knowledge"),
      }),
    );
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.workspaceId, c.get("workspaceId"))));
    if (!agent) throw new BridgeError("not_found", "agent not found");
    const [memory] = await deps.db
      .insert(memoryEntries)
      .values({
        id: id("mem"),
        workspaceId: c.get("workspaceId"),
        agentId: body.agentId,
        kind: body.kind,
        content: body.content,
      })
      .returning();
    return c.json({ memory }, 201);
  });

  app.delete("/:memoryId", requireRole("owner", "admin"), async (c) => {
    const [deleted] = await deps.db
      .delete(memoryEntries)
      .where(
        and(
          eq(memoryEntries.id, c.req.param("memoryId")),
          eq(memoryEntries.workspaceId, c.get("workspaceId")),
        ),
      )
      .returning({ id: memoryEntries.id });
    if (!deleted) throw new BridgeError("not_found", "memory entry not found");
    return c.body(null, 204);
  });

  /**
   * The graph itself: nodes, the links between them, and how strongly each is
   * believed. One request rather than one per node — the view draws all of it
   * at once, and a graph fetched piecewise is a graph that jumps about while
   * it loads.
   */
  app.get("/graph", async (c) => {
    const workspaceId = c.get("workspaceId");
    const agentId = c.req.query("agentId");

    const nodes = await deps.db
      .select({
        id: knowledgeNodes.id,
        agentId: knowledgeNodes.agentId,
        agentName: agents.name,
        title: knowledgeNodes.title,
        kind: knowledgeNodes.kind,
        body: knowledgeNodes.body,
        confidence: knowledgeNodes.confidence,
        mentions: knowledgeNodes.mentions,
        sourceRunId: knowledgeNodes.sourceRunId,
        createdAt: knowledgeNodes.createdAt,
        updatedAt: knowledgeNodes.updatedAt,
      })
      .from(knowledgeNodes)
      .innerJoin(agents, eq(agents.id, knowledgeNodes.agentId))
      .where(
        and(
          eq(knowledgeNodes.workspaceId, workspaceId),
          ...(agentId ? [eq(knowledgeNodes.agentId, agentId)] : []),
        ),
      )
      .orderBy(desc(knowledgeNodes.updatedAt))
      .limit(500);

    const ids = new Set(nodes.map((node) => node.id));
    const allEdges = await deps.db
      .select({
        id: knowledgeEdges.id,
        fromId: knowledgeEdges.fromId,
        toId: knowledgeEdges.toId,
        relation: knowledgeEdges.relation,
      })
      .from(knowledgeEdges)
      .where(eq(knowledgeEdges.workspaceId, workspaceId))
      .limit(2000);

    return c.json({
      nodes,
      // An edge to a node that was not returned would draw a line to nowhere.
      edges: allEdges.filter((edge) => ids.has(edge.fromId) && ids.has(edge.toId)),
    });
  });

  app.delete("/graph/:nodeId", requireRole("owner", "admin"), async (c) => {
    const [deleted] = await deps.db
      .delete(knowledgeNodes)
      .where(
        and(
          eq(knowledgeNodes.id, c.req.param("nodeId")),
          eq(knowledgeNodes.workspaceId, c.get("workspaceId")),
        ),
      )
      .returning({ id: knowledgeNodes.id });
    if (!deleted) throw new BridgeError("not_found", "that is not something I know");
    return c.body(null, 204);
  });

  return app;
}
