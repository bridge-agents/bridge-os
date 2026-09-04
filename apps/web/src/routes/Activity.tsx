import { Activity as ActivityIcon, CircleAlert, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ActivityRun,
  type AgentSummary,
  api,
  BridgeApiError,
  type RunActivity,
  type RuntimeHealth,
  type WorkspaceUsage,
} from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { useWorkspaceId } from "../session.jsx";
import { EmptyState, ErrorText, SectionHeader, Spinner } from "../ui.jsx";
import { duration, RunTrace } from "./RunTrace.jsx";

/**
 * Everything the system has done, and what it cost.
 *
 * Phase 9's acceptance test is three clicks from anywhere to "what did this
 * run do, what did it call, what did it cost, why did it fail". So: one list,
 * filters that narrow it, and a row that opens the full trace beside it —
 * the answer is the second click, and the third is only ever expanding a
 * payload.
 */
const STATUSES = ["succeeded", "failed", "running", "queued", "waiting_approval", "cancelled"];

const STATUS_STYLE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  succeeded: "outline",
  failed: "destructive",
  cancelled: "secondary",
  running: "default",
  queued: "secondary",
  waiting_approval: "secondary",
};

const money = (value: string | null) => (value === null ? "—" : `$${Number(value).toFixed(4)}`);

const when = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );

const took = (run: ActivityRun) =>
  duration(
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null,
  );

function HealthBanner({ health }: { health: RuntimeHealth }) {
  if (health.state === "healthy") return null;
  const stalled = health.state === "stalled";
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border p-3 ${
        stalled
          ? "border-destructive/40 bg-destructive/5"
          : "border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20"
      }`}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="text-[13px]">
        <p className="font-medium">
          {stalled ? "Work is queued but nothing is running it" : "Runs are failing"}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          {stalled
            ? `${health.live.stalled} run${health.live.stalled === 1 ? "" : "s"} waiting more than a minute. Is the Bridge runtime running?`
            : `${health.lastHour.failed} of ${health.lastHour.runs} runs in the last hour failed.`}
        </p>
      </div>
    </div>
  );
}

export function Activity() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [runs, setRuns] = useState<ActivityRun[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [selected, setSelected] = useState<RunActivity | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = params.get("status") ?? "all";
  const agentId = params.get("agent") ?? "all";

  const load = useCallback(async () => {
    const [list, agentList, workspaceUsage, runtime] = await Promise.all([
      api.activityRuns(workspaceId, {
        ...(status !== "all" ? { status } : {}),
        ...(agentId !== "all" ? { agentId } : {}),
      }),
      api.agents(workspaceId),
      api.usage(workspaceId),
      api.runtimeHealth(workspaceId),
    ]);
    setRuns(list.runs);
    setCursor(list.nextCursor);
    setAgents(agentList.agents);
    setUsage(workspaceUsage);
    setHealth(runtime.health);
  }, [workspaceId, status, agentId]);

  useEffect(() => {
    void load().catch((cause) =>
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not load activity."),
    );
  }, [load]);

  const more = async () => {
    if (!cursor) return;
    const next = await api.activityRuns(workspaceId, {
      cursor,
      ...(status !== "all" ? { status } : {}),
      ...(agentId !== "all" ? { agentId } : {}),
    });
    setRuns((current) => [...(current ?? []), ...next.runs]);
    setCursor(next.nextCursor);
  };

  const open = async (run: ActivityRun) => {
    setLoadingRun(true);
    setError(null);
    try {
      setSelected(await api.runActivity(workspaceId, run.id));
    } catch (cause) {
      setError(cause instanceof BridgeApiError ? cause.error.message : "Could not load that run.");
    } finally {
      setLoadingRun(false);
    }
  };

  const narrow = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  if (!runs) return <Spinner label="Loading activity" />;

  return (
    <div className="flex w-full flex-col gap-6">
      <SectionHeader
        title="Activity"
        description="Every run, what it called, what it cost, and why it failed."
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw /> Refresh
          </Button>
        }
      />

      {health && <HealthBanner health={health} />}

      {usage && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            ["Runs", usage.totals.runs.toLocaleString(), "last 30 days"],
            ["Failed", usage.totals.failed.toLocaleString(), "last 30 days"],
            ["Spend", `$${Number(usage.totals.costUsd).toFixed(2)}`, "last 30 days"],
            [
              "Tokens",
              `${(
                (Number(usage.totals.inputTokens) + Number(usage.totals.outputTokens)) / 1000
              ).toFixed(1)}k`,
              "in + out",
            ],
            ["Median run", duration(usage.totals.medianSeconds * 1000), "start to finish"],
          ].map(([label, value, note]) => (
            <div key={label} className="rounded-lg border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              <p className="text-[11px] text-muted-foreground">{note}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 sm:flex-row">
        <Select value={agentId} onValueChange={(value) => narrow("agent", value)}>
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(value) => narrow("status", value)}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ErrorText>{error}</ErrorText>

      {runs.length === 0 ? (
        <EmptyState title="No runs yet">
          <span className="inline-flex items-center gap-2">
            <ActivityIcon className="size-4" /> Send an agent a message, or wait for a schedule.
          </span>
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="w-36">Status</TableHead>
                <TableHead className="w-28">Trigger</TableHead>
                <TableHead className="w-24 text-right">Cost</TableHead>
                <TableHead className="w-24 text-right">Took</TableHead>
                <TableHead className="w-40">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow
                  key={run.id}
                  className="cursor-pointer"
                  onClick={() => void open(run)}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void open(run);
                  }}
                >
                  <TableCell>
                    <span className="font-medium">{run.agentName}</span>
                    {run.error && (
                      <span className="block max-w-md truncate text-[12px] text-destructive">
                        {run.error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_STYLE[run.status] ?? "secondary"}>
                      {run.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{run.trigger}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(run.costUsd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{took(run)}</TableCell>
                  <TableCell className="text-muted-foreground">{when(run.queuedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {cursor && (
        <Button variant="outline" onClick={() => void more()} className="self-center">
          Load more
        </Button>
      )}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {selected?.run.agentName}
              {selected && (
                <Badge variant={STATUS_STYLE[selected.run.status] ?? "secondary"}>
                  {selected.run.status.replace("_", " ")}
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription>
              {selected && `${selected.run.trigger} · ${when(selected.run.queuedAt)}`}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-8">
            {loadingRun && <Spinner label="Loading trace" />}
            {selected && !loadingRun && <RunTrace activity={selected} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
