import { Check, Clock3, Loader2, TimerReset, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type Approval, api, BridgeApiError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { useWorkspaceId } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";
import { EmptyState, ErrorText, SectionHeader, Spinner } from "../ui.jsx";

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
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not record that decision.",
      );
    } finally {
      setBusy(null);
    }
  };

  const extend = async (approval: Approval) => {
    setBusy(approval.id);
    setError(null);
    try {
      await api.extendApproval(workspaceId, approval.id, 1);
      await load();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError ? cause.error.message : "Could not extend that approval.",
      );
    } finally {
      setBusy(null);
    }
  };

  if (!pending) return <Spinner label="Loading approvals" />;

  return (
    <div className="flex w-full flex-col gap-6">
      <SectionHeader
        title="Approval queue"
        description="Review the exact tool, action, and input before allowing a paused agent to continue."
        action={
          pending.length ? (
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
              <Clock3 /> {pending.length} paused
            </Badge>
          ) : null
        }
      />
      <ErrorText>{error}</ErrorText>

      {pending.length === 0 ? (
        <EmptyState title="Nothing to approve">
          Agents only pause for actions their permissions mark as requiring a human.
        </EmptyState>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {pending.map((approval) => (
            <Card key={approval.id} className="rounded-lg border-l-4 border-l-amber-500">
              <CardHeader>
                <ToolIcon tool={approval.toolName} className="mb-2 size-9" />
                <CardTitle>{approval.toolName}</CardTitle>
                <CardDescription>
                  <span className="font-medium text-foreground">
                    {approval.agentTitle ?? approval.agentName ?? "Agent"}
                  </span>{" "}
                  wants to <span className="font-mono text-foreground">{approval.action}</span>.
                </CardDescription>
                <CardAction>
                  <span className="text-xs text-muted-foreground">
                    {new Date(approval.createdAt).toLocaleTimeString()}
                  </span>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                <pre className="max-h-52 overflow-auto rounded-lg border bg-muted/35 p-3 font-mono text-xs">
                  {JSON.stringify(approval.input, null, 2)}
                </pre>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate font-mono">{approval.runId}</span>
                  {approval.agentId && (
                    <Link
                      to={`/agents/${approval.agentId}`}
                      className="shrink-0 font-medium text-primary hover:underline"
                    >
                      Open agent
                    </Link>
                  )}
                </div>
                {approval.expiresAt && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                    <span>Expires {new Date(approval.expiresAt).toLocaleString()}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy === approval.id}
                      onClick={() => void extend(approval)}
                    >
                      <TimerReset /> Add 1 hour
                    </Button>
                  </div>
                )}
                <Input
                  aria-label={`Reason for denying ${approval.toolName}`}
                  value={reasons[approval.id] ?? ""}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [approval.id]: event.target.value }))
                  }
                  placeholder="Optional reason if denying"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy === approval.id}
                    onClick={() => void decide(approval, true)}
                  >
                    {busy === approval.id ? <Loader2 className="animate-spin" /> : <Check />} Allow
                    once
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy === approval.id}
                    onClick={() => void decide(approval, false)}
                  >
                    <X /> Deny
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
