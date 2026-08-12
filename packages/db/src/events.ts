import { createEvent, type EventType } from "@bridge/spec";
import type { Db } from "./client.js";
import { events } from "./schema.js";

/**
 * Append to the audit/event log. Every significant action records one; the
 * same rows later feed realtime UI, automations and observability. Lives here
 * so the control plane and the runtime write events the same way.
 */
export async function appendEvent(
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
