import {
  AlertTriangle,
  CalendarClock,
  Pause,
  Pencil,
  Play,
  Repeat,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type Automation, api, BridgeApiError } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, SectionHeader, Spinner } from "../ui.jsx";
import { AutomationEditor } from "./AutomationEditor.jsx";

/**
 * What Bridge is going to do without being asked.
 *
 * The page answers three questions in order of how often they are asked:
 * what runs next, did the last one work, and how do I stop it.
 *
 * Editing and deleting here write the *agent's manifest*, because that is
 * the single definition (invariant 1) — this page is a convenient way into
 * it, not a second place a schedule can live. Creating one is still the
 * agent's job, since a new trigger needs an agent to belong to.
 */
export function Automations() {
  const workspaceId = useWorkspaceId();
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { automations: rows } = await api.automations(workspaceId);
    setAutomations(rows);
  }, [workspaceId]);

  useEffect(() => {
    void load();
    // Long enough not to be chatty, short enough that "next run" stays true.
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
  }, [load]);

  const act = async (automation: Automation, action: "pause" | "resume" | "run") => {
    setBusy(automation.id);
    setError(null);
    try {
      await api.automationAction(workspaceId, automation.id, action);
      await load();
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Deleting removes the trigger from the agent's manifest, so it is worth a
   * second press rather than a dialog nobody reads — and worth being clear
   * that it is the agent being changed, not just this list.
   */
  const remove = async (automation: Automation) => {
    if (confirmDelete !== automation.id) {
      setConfirmDelete(automation.id);
      return;
    }
    setBusy(automation.id);
    setError(null);
    try {
      await api.deleteAutomation(workspaceId, automation.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err instanceof BridgeApiError ? err.error.message : "Could not delete that.");
    } finally {
      setBusy(null);
    }
  };

  if (!automations) return <Spinner label="Loading automations" />;

  if (automations.length === 0) {
    return (
      <EmptyState title="Nothing is scheduled">
        Add a schedule to an agent, deploy it, and it appears here.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Automations"
        description="Work Bridge does on its own. Everything here runs only while Bridge is running."
      />
      <ErrorText>{error}</ErrorText>

      <ul className="flex flex-col gap-2">
        {automations.map((automation) => (
          <li
            key={automation.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border p-3"
          >
            <KindIcon kind={automation.kind} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{automation.title}</span>
                <StatusBadge automation={automation} />
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {automation.agentName} · {automation.schedule}
                {automation.runsCount > 0 &&
                  ` · ${automation.runsCount} run${automation.runsCount === 1 ? "" : "s"}`}
              </p>
              {/* The reason an automation stopped is the whole point of
                  showing its status, so it is never hidden behind a hover. */}
              {automation.statusReason && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {automation.statusReason}
                </p>
              )}
            </div>

            <div className="text-right text-xs text-muted-foreground">
              <div className="uppercase tracking-wide">Next</div>
              <div>{formatNext(automation)}</div>
            </div>

            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={busy === automation.id}
                onClick={() => act(automation, "run")}
              >
                Run now
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Edit ${automation.title}`}
                disabled={busy === automation.id}
                onClick={() => setEditing(automation)}
              >
                <Pencil className="size-4" />
              </Button>
              {automation.status === "active" ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Pause ${automation.title}`}
                  disabled={busy === automation.id}
                  onClick={() => act(automation, "pause")}
                >
                  <Pause className="size-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Resume ${automation.title}`}
                  disabled={busy === automation.id}
                  onClick={() => act(automation, "resume")}
                >
                  <Play className="size-4" />
                </Button>
              )}
              <Button
                variant={confirmDelete === automation.id ? "destructive" : "ghost"}
                size={confirmDelete === automation.id ? "sm" : "icon"}
                aria-label={`Delete ${automation.title}`}
                disabled={busy === automation.id}
                onClick={() => remove(automation)}
                onBlur={() => setConfirmDelete(null)}
              >
                {confirmDelete === automation.id ? "Really delete?" : <Trash2 className="size-4" />}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <AutomationEditor
          workspaceId={workspaceId}
          automation={editing}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === "event" ? Zap : kind === "interval" ? Repeat : CalendarClock;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function StatusBadge({ automation }: { automation: Automation }) {
  if (automation.status === "disabled") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="size-3" />
        stopped
      </Badge>
    );
  }
  if (automation.status === "completed") return <Badge variant="secondary">finished</Badge>;
  if (automation.status === "paused") return <Badge variant="outline">paused</Badge>;
  return <Badge variant="secondary">active</Badge>;
}

/**
 * "In 4 minutes" beats a timestamp for the question people actually have,
 * which is whether the thing they just set up is about to happen.
 */
function formatNext(automation: Automation): string {
  if (automation.kind === "event") return "on event";
  if (!automation.nextRunAt || automation.status !== "active") return "—";

  const ms = Date.parse(automation.nextRunAt) - Date.now();
  if (ms <= 0) return "any moment";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes || 1} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return new Date(automation.nextRunAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
