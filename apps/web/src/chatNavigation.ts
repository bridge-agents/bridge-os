export function newChatParams(agentId?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (agentId) params.set("agent", agentId);
  params.set("draft", crypto.randomUUID());
  return params;
}

export function chatSessionKey(params: URLSearchParams): string {
  return params.get("conversation") ?? `draft:${params.get("draft") ?? "default"}`;
}
