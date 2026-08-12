/**
 * Prefixed opaque ids: "ws_...", "agt_...", "run_...". The prefix makes ids
 * self-describing in logs and API payloads.
 */
export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export const newWorkspaceId = () => id("ws");
export const newUserId = () => id("usr");
export const newAgentId = () => id("agt");
export const newRunId = () => id("run");
export const newEventId = () => id("evt");
