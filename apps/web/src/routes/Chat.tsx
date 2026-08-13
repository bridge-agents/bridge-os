import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type AgentSummary, type Approval, api, BridgeApiError } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import { Badge, Button, Card, EmptyState, ErrorText, Input, Select, Spinner } from "../ui.jsx";

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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  /*
   * The URL is the state, not a copy of it. The sidebar opens a thread by
   * navigating, so holding these in useState would ignore every click after
   * the first mount — "New chat" especially, which only changes the query.
   */
  const [fallbackAgentId, setFallbackAgentId] = useState("");
  const agentId = params.get("agent") ?? fallbackAgentId;
  const conversationId = params.get("conversation") ?? undefined;

  const setAgentId = (id: string) => setParams({ agent: id }, { replace: true });

  useEffect(() => {
    void api.agents(workspaceId).then(({ agents: list }) => {
      setAgents(list);
      // Default to the first deployed agent so chat is usable immediately.
      setFallbackAgentId(list.find((agent) => agent.status === "deployed")?.id ?? "");
    });
  }, [workspaceId]);

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
    <div className="flex flex-1 flex-col gap-5">
      {/* Agent selector reads as a drawing's title block: which structure,
          and the control to start a fresh span. */}
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor="chat-agent"
          className="font-condensed text-[11px] font-semibold uppercase tracking-[0.1em] text-text-muted"
        >
          Agent
        </label>
        <Select
          id="chat-agent"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setTurns([]);
          }}
        >
          {deployed.length === 0 && <option value="">No deployed agents</option>}
          {deployed.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        {conversationId && (
          <Button
            variant="quiet"
            onClick={() => {
              setTurns([]);
              setParams({ agent: agentId }, { replace: true });
            }}
          >
            New conversation
          </Button>
        )}
      </div>

      {deployed.length === 0 ? (
        <EmptyState title="Nothing deployed yet">
          Deploy an agent from the Agents page and it will appear here, ready to talk to.
        </EmptyState>
      ) : (
        <>
          <div className="flex min-h-[22rem] flex-1 flex-col gap-4">
            {turns.length === 0 && (
              <p className="py-8 text-center text-sm text-text-faint">
                Ask for something. You will see every tool it reaches for.
              </p>
            )}
            {turns.map((turn, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
                key={index}
                className={
                  turn.role === "user"
                    ? "max-w-[80%] self-end rounded-[var(--radius-md)] border border-border-strong bg-bg-overlay px-3.5 py-2.5"
                    : "flex max-w-[88%] flex-col gap-2 self-start border-l border-border pl-3.5"
                }
              >
                {/*
                  Tool activity is annotation on the answer, not a message of
                  its own: it says how the answer was reached.
                */}
                {turn.activity && turn.activity.length > 0 && (
                  <ul className="flex flex-col gap-1">
                    {turn.activity.map((entry) => (
                      <li key={entry} className="font-mono text-[11px] text-text-faint">
                        {entry}
                      </li>
                    ))}
                  </ul>
                )}
                <p
                  className={`whitespace-pre-wrap text-sm leading-relaxed ${
                    turn.role === "user" ? "" : "text-text"
                  }`}
                >
                  {turn.content}
                  {turn.streaming && (
                    <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-accent align-text-bottom" />
                  )}
                </p>
              </div>
            ))}
            <div ref={bottom} />
          </div>

          {/* The stop-the-machine moment: given the most weight on the page. */}
          {pending.length > 0 && (
            <Card className="flex flex-col gap-3 border-warning/50 bg-warning/[0.06]">
              <div className="flex items-center gap-2">
                <Badge tone="warning">paused</Badge>
                <span className="font-condensed text-[13px] font-semibold uppercase tracking-[0.1em]">
                  Waiting on you
                </span>
              </div>
              {pending.map((approval) => (
                <div key={approval.id} className="flex flex-col gap-2">
                  <p className="text-sm text-text-muted">
                    <span className="font-mono text-text">{approval.toolName}</span> wants to{" "}
                    {approval.action}.
                  </p>
                  <pre className="max-h-32 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg p-2.5 font-mono text-[11px] text-text-muted">
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

          <form onSubmit={send} className="flex items-end gap-2 pb-1">
            <Input
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message…"
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !input.trim()}>
              {busy ? "Sending…" : "Send"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
