import { appendEvent, approvals, type Db, runs } from "@bridge/db";
import { and, eq, lt } from "drizzle-orm";

/**
 * Turn overdue approvals into explicit denials and release their parked runs.
 * The pending-status predicate makes this safe to call from every executor.
 */
export async function expirePendingApprovals(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .update(approvals)
    .set({
      status: "expired",
      reason: "Approval expired before it was reviewed.",
      decidedAt: now,
    })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
    .returning({
      id: approvals.id,
      workspaceId: approvals.workspaceId,
      runId: approvals.runId,
      toolName: approvals.toolName,
    });

  for (const approval of expired) {
    await db
      .update(runs)
      .set({ status: "queued", heartbeatAt: null })
      .where(and(eq(runs.id, approval.runId), eq(runs.status, "waiting_approval")));
    await appendEvent(db, "approval.denied", {
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      data: {
        approvalId: approval.id,
        tool: approval.toolName,
        reason: "expired",
      },
    });
  }

  return expired.length;
}
