import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type Approval, api, BridgeApiError } from "../api.js";
import { useWorkspaceId } from "../session.jsx";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  SectionHeader,
  Spinner,
} from "../ui.jsx";

/**
 * The queue of things agents are waiting on a human for. Each entry shows
 * exactly what would run, so approving is an informed decision rather than a
 * rubber stamp.
 */
export function Approvals() {
  const workspaceId = useWorkspaceId();
  const [pending, setPending] = useState<Approval[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { approvals } = await api.approvals(workspaceId);
    setPending(approvals);
  }, [workspaceId]);

  useEffect(() => {
    void load();
    // Agents can pause at any time, so keep the queue fresh.
    const interval = setInterval(() => void load(), 5000);
    return () => clearInterval(interval);
  }, [load]);

  const decide = async (approval: Approval, approved: boolean) => {
    setBusy(approval.id);
    setError(null);
    try {
      if (approved) await api.approve(workspaceId, approval.id);
      else await api.deny(workspaceId, approval.id, reasons[approval.id]?.trim() || undefined);
      await load();
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not record that.");
    } finally {
      setBusy(null);
    }
  };

  if (!pending) return <Spinner label="Loading approvals" />;

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Waiting for you"
        description="These agents have paused mid-run. Nothing happens until you decide."
        action={pending.length > 0 ? <Badge tone="warning">{pending.length} paused</Badge> : null}
      />

      <ErrorText>{error}</ErrorText>

      {pending.length === 0 ? (
        <EmptyState title="Nothing to approve">
          Agents only pause for actions their permissions mark as needing a human.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {pending.map((approval) => (
            <li key={approval.id}>
              <Card className="flex flex-col gap-3 border-l-2 border-l-warning">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="text-sm">
                      <span className="font-medium">{approval.agentTitle ?? "Agent"}</span>
                      <span className="text-text-muted"> wants to </span>
                      <span className="font-mono text-text">{approval.action}</span>
                      <span className="text-text-muted"> with </span>
                      <span className="font-mono text-text">{approval.toolName}</span>
                    </p>
                    <p className="font-mono text-xs text-text-faint">
                      {approval.agentName ? `${approval.agentName} · ` : ""}
                      <Link to={`/agents/${approval.agentId ?? ""}`} className="hover:underline">
                        {approval.runId}
                      </Link>
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-text-faint">
                    {new Date(approval.createdAt).toLocaleTimeString()}
                  </span>
                </div>

                <pre className="max-h-48 overflow-auto rounded-[var(--radius-sm)] border border-border bg-bg p-3 font-mono text-[11px]">
                  {JSON.stringify(approval.input, null, 2)}
                </pre>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    aria-label="Reason for denying"
                    value={reasons[approval.id] ?? ""}
                    onChange={(e) =>
                      setReasons((current) => ({ ...current, [approval.id]: e.target.value }))
                    }
                    placeholder="Reason (sent to the agent if you deny)"
                  />
                  <div className="flex gap-2">
                    <Button disabled={busy === approval.id} onClick={() => decide(approval, true)}>
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy === approval.id}
                      onClick={() => decide(approval, false)}
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
