import { BridgeError } from "@bridge/core";
import { agents, appendEvent, approvals, runs } from "@bridge/db";
import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireWorkspace } from "./auth.js";
import { type AppDeps, type AppEnv, parseBody } from "./http.js";

/**
 * The human half of the permission engine.
 *
 * When a policy says `ask`, the run parks in `waiting_approval` with its loop
 * checkpointed. Deciding here releases it: the run goes back to `queued` and
 * an executor resumes it from the exact tool call that was waiting.
 */
export function approvalRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth(deps), requireWorkspace(deps));

  app.get("/", async (c) => {
    const status = c.req.query("status") ?? "pending";
    const rows = await deps.db
      .select({
        id: approvals.id,
        runId: approvals.runId,
        agentId: approvals.agentId,
        agentName: approvals.agentName,
        toolName: approvals.toolName,
        action: approvals.action,
        input: approvals.input,
        status: approvals.status,
        reason: approvals.reason,
        createdAt: approvals.createdAt,
        decidedAt: approvals.decidedAt,
        agentTitle: agents.name,
      })
      .from(approvals)
      .leftJoin(agents, eq(agents.id, approvals.agentId))
      .where(
        and(
          eq(approvals.workspaceId, c.get("workspaceId")),
          ...(status === "all" ? [] : [eq(approvals.status, status)]),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(100);
    return c.json({ approvals: rows });
  });

  const decide = async (c: Context<AppEnv>, approved: boolean, reason?: string) => {
    const workspaceId = c.get("workspaceId");
    const approvalId = c.req.param("approvalId");
    if (!approvalId) throw new BridgeError("not_found", "approval not found");

    // Only a pending approval can be decided — deciding twice must not
    // requeue a run that has already moved on.
    const decided = await deps.db
      .update(approvals)
      .set({
        status: approved ? "approved" : "denied",
        reason,
        decidedBy: c.get("userId"),
        decidedAt: new Date(),
      })
      .where(
        and(
          eq(approvals.workspaceId, workspaceId),
          eq(approvals.id, approvalId),
          eq(approvals.status, "pending"),
        ),
      )
      .returning({ id: approvals.id, runId: approvals.runId, toolName: approvals.toolName });

    const approval = decided[0];
    if (!approval) {
      throw new BridgeError("not_found", "no pending approval with that id");
    }

    // Hand the run back to the executor.
    await deps.db
      .update(runs)
      .set({ status: "queued", heartbeatAt: null })
      .where(and(eq(runs.id, approval.runId), eq(runs.status, "waiting_approval")));

    await appendEvent(deps.db, approved ? "approval.approved" : "approval.denied", {
      workspaceId,
      runId: approval.runId,
      data: { approvalId, tool: approval.toolName, reason },
    });

    return c.json({
      approval: { id: approvalId, status: approved ? "approved" : "denied", reason },
    });
  };

  app.post("/:approvalId/approve", (c) => decide(c, true));

  app.post("/:approvalId/deny", async (c) => {
    const body = await parseBody(c, z.object({ reason: z.string().max(2000).optional() }));
    return decide(c, false, body.reason);
  });

  return app;
}
