import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type AgentSummary, type Approval, api, BridgeApiError } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Button, Card, EmptyState, ErrorText, Input, Spinner } from "../ui.jsx";

/**
 * Bridge Chat: a conversation with one agent, streamed.
 *
 * Everything here comes off the public API — the conversation endpoints for
 * history, the run stream for live text and tool activity, and the approvals
 * endpoints for the cards. Nothing is chat-specific on the server.
 */
interface Turn {
  role: "user" | "assistant";
  content: string;
  /** Tool activity observed while this answer was produced. */
  activity?: string[];
  streaming?: boolean;
}

export function Chat() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();

  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  const [conversationId, setConversationId] = useState<string | undefined>(
    params.get("conversation") ?? undefined,
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.agents(workspaceId).then(({ agents: list }) => {
      setAgents(list);
      // Default to the first deployed agent so chat is usable immediately.
      if (!agentId) setAgentId(list.find((agent) => agent.status === "deployed")?.id ?? "");
    });
  }, [workspaceId, agentId]);

  // Replay an existing conversation when one is selected.
  useEffect(() => {
    if (!conversationId) return setTurns([]);
    void api
      .conversation(workspaceId, conversationId)
      .then(({ messages }) =>
        setTurns(
          messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
              role: message.role as "user" | "assistant",
              content: message.content,
            })),
        ),
      )
      .catch(() => setTurns([]));
  }, [workspaceId, conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const refreshApprovals = useCallback(async () => {
    const { approvals } = await api.approvals(workspaceId);
    setPending(approvals);
  }, [workspaceId]);

  /** Append to the assistant turn currently being streamed. */
  const updateLast = (change: (turn: Turn) => Turn) =>
    setTurns((current) => {
      const next = [...current];
      const last = next.at(-1);
      if (last) next[next.length - 1] = change(last);
      return next;
    });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || !agentId) return;

    setBusy(true);
    setError(null);
    setInput("");
    setTurns((current) => [
      ...current,
      { role: "user", content: text },
      { role: "assistant", content: "", activity: [], streaming: true },
    ]);

    try {
      const { run } = await api.startRun(workspaceId, agentId, text, conversationId);
      setConversationId(run.conversationId);
      setParams({ agent: agentId, conversation: run.conversationId }, { replace: true });

      await api.streamRun(workspaceId, run.id, {
        onDelta: (delta) => updateLast((turn) => ({ ...turn, content: turn.content + delta })),
        onStep: (step) => {
          const data = step.data as Record<string, unknown>;
          const label =
            step.type === "tool_call"
              ? `${String(data.tool)} ${data.executed ? "ran" : "skipped"}`
              : step.type === "delegation"
                ? `delegated to ${String(data.to)}`
                : undefined;
          if (label)
            updateLast((turn) => ({ ...turn, activity: [...(turn.activity ?? []), label] }));
        },
        onStatus: (status, output) => {
          // Without token deltas the answer only exists at the end.
          updateLast((turn) => ({
            ...turn,
            content: turn.content || output?.content || "",
            streaming: false,
          }));
          if (status === "waiting_approval") void refreshApprovals();
        },
      });
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Something went wrong.");
      updateLast((turn) => ({ ...turn, streaming: false }));
    } finally {
      setBusy(false);
      bottom.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  /** Deciding here resumes the paused run, so pick the conversation back up. */
  const decide = async (approval: Approval, approved: boolean) => {
    if (approved) await api.approve(workspaceId, approval.id);
    else await api.deny(workspaceId, approval.id);
    await refreshApprovals();

    setTurns((current) => [
      ...current,
      { role: "assistant", content: "", activity: [], streaming: true },
    ]);
    await api.streamRun(workspaceId, approval.runId, {
      onDelta: (delta) => updateLast((turn) => ({ ...turn, content: turn.content + delta })),
      onStep: () => {},
      onStatus: (_status, output) =>
        updateLast((turn) => ({
          ...turn,
          content: turn.content || output?.content || "",
          streaming: false,
        })),
    });
  };

  if (!agents) return <Spinner label="Loading chat" />;

  const deployed = agents.filter((agent) => agent.status === "deployed");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="chat-agent" className="text-xs text-text-muted">
            Agent
          </label>
          <select
            id="chat-agent"
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setConversationId(undefined);
              setTurns([]);
            }}
            className="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-sm outline-none"
          >
            {deployed.length === 0 && <option value="">No deployed agents</option>}
            {deployed.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
        {conversationId && (
          <Button
            variant="ghost"
            onClick={() => {
              setConversationId(undefined);
              setTurns([]);
              setParams({ agent: agentId }, { replace: true });
            }}
          >
            New conversation
          </Button>
        )}
      </div>

      {deployed.length === 0 ? (
        <EmptyState title="No deployed agents">
          Deploy an agent from the Agents page to start chatting.
        </EmptyState>
      ) : (
        <>
          <div className="flex min-h-[24rem] flex-col gap-3">
            {turns.length === 0 && (
              <p className="text-sm text-text-muted">Say something to get started.</p>
            )}
            {turns.map((turn, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
                key={index}
                className={`max-w-[85%] rounded-[var(--radius-md)] border px-4 py-3 ${
                  turn.role === "user"
                    ? "self-end border-border-strong bg-bg-overlay"
                    : "self-start border-border bg-bg-raised"
                }`}
              >
                {turn.activity && turn.activity.length > 0 && (
                  <ul className="mb-2 flex flex-col gap-0.5">
                    {turn.activity.map((entry) => (
                      <li key={entry} className="font-mono text-[11px] text-text-faint">
                        ⚙ {entry}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="whitespace-pre-wrap text-sm">
                  {turn.content}
                  {turn.streaming && <span className="animate-pulse text-text-faint">▋</span>}
                </p>
              </div>
            ))}
            <div ref={bottom} />
          </div>

          {pending.length > 0 && (
            <Card className="flex flex-col gap-3 border-warning/40">
              <p className="text-sm font-medium">Waiting on you</p>
              {pending.map((approval) => (
                <div key={approval.id} className="flex flex-col gap-2">
                  <p className="text-sm">
                    Run <span className="font-mono">{approval.toolName}</span> ({approval.action})?
                  </p>
                  <pre className="max-h-32 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg p-2 font-mono text-[11px]">
                    {JSON.stringify(approval.input, null, 2)}
                  </pre>
                  <div className="flex gap-2">
                    <Button onClick={() => decide(approval, true)}>Approve</Button>
                    <Button variant="danger" onClick={() => decide(approval, false)}>
                      Deny
                    </Button>
                  </div>
                </div>
              ))}
            </Card>
          )}

          <ErrorText>{error}</ErrorText>

          <form onSubmit={send} className="flex items-end gap-2">
            <Input
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message…"
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !input.trim()}>
              {busy ? "…" : "Send"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
