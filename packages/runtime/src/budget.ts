import { type Db, runs } from "@bridge/db";
import type { Manifest } from "@bridge/spec";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Has this agent spent its allowance today?
 *
 * Shared between the API and the automation runner deliberately. A budget
 * that only applies to work you started by hand protects nothing: the runs
 * that spend money while you are not looking are exactly the scheduled ones.
 */
export async function dailyBudgetExceeded(
  db: Db,
  workspaceId: string,
  agentId: string,
  limits: Manifest["runtime"]["limits"],
): Promise<string | undefined> {
  if (limits.dailyTokenBudget === undefined && limits.dailySpendUsd === undefined) return undefined;

  // UTC days, so the boundary does not move with the caller's clock.
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);

  const [usage] = await db
    .select({
      tokens: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens}), 0)`,
      spendUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .where(
      and(eq(runs.workspaceId, workspaceId), eq(runs.agentId, agentId), gte(runs.queuedAt, start)),
    );

  const tokens = Number(usage?.tokens ?? 0);
  const spend = Number(usage?.spendUsd ?? 0);

  if (limits.dailyTokenBudget !== undefined && tokens >= limits.dailyTokenBudget) {
    return `daily token budget reached (${tokens}/${limits.dailyTokenBudget})`;
  }
  if (limits.dailySpendUsd !== undefined && spend >= limits.dailySpendUsd) {
    return `daily spend budget reached ($${spend.toFixed(2)}/$${limits.dailySpendUsd})`;
  }
  return undefined;
}
