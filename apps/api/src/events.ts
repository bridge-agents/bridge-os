import { type Db, events } from "@bridge/db";
import { createEvent, type EventType } from "@bridge/spec";

/**
 * Append to the audit/event log. Every significant action records one; the
 * same rows later feed realtime UI, automations and observability.
 */
export async function recordEvent(
  db: Db,
  type: EventType,
  fields: {
    workspaceId: string;
    agentId?: string;
    runId?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  const event = createEvent(type, fields);
  await db.insert(events).values({
    id: event.id,
    workspaceId: event.workspaceId,
    agentId: event.agentId,
    runId: event.runId,
    type: event.type,
    data: event.data,
  });
}
