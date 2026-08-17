import { z } from "zod";

/**
 * Typed event catalog. Events are the audit log, the realtime feed, and the
 * automation trigger source. Payload (`data`) stays an open record until each
 * emitter lands; the envelope and type union are stable contracts now.
 */
export const EVENT_TYPES = [
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.started",
  "agent.stopped",
  "run.started",
  "run.completed",
  "run.failed",
  "task.created",
  "task.completed",
  "task.failed",
  "tool.requested",
  "tool.executed",
  "tool.failed",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "message.received",
  "message.sent",
  "memory.created",
  "deployment.started",
  "deployment.ready",
  "deployment.failed",
  "provider.error",
  /** An automation started a run, or reached its end. */
  "automation.fired",
  "automation.ended",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const BridgeEventSchema = z.object({
  id: z.string().min(1),
  type: EventTypeSchema,
  ts: z.iso.datetime(),
  workspaceId: z.string().min(1),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type BridgeEvent = z.infer<typeof BridgeEventSchema>;

export function createEvent(
  type: EventType,
  fields: {
    workspaceId: string;
    agentId?: string;
    runId?: string;
    data?: Record<string, unknown>;
  },
): BridgeEvent {
  return {
    id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
    type,
    ts: new Date().toISOString(),
    workspaceId: fields.workspaceId,
    agentId: fields.agentId,
    runId: fields.runId,
    data: fields.data ?? {},
  };
}
