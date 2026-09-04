import { AlertCircle, ChevronRight, CornerDownRight, Cpu, ShieldCheck, Wrench } from "lucide-react";
import { useState } from "react";
import type { RunActivity, TraceStep } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { ToolIcon } from "../ToolIcon.jsx";

/**
 * What one run actually did, step by step.
 *
 * The trace is the answer to three of Phase 9's four questions, so it is
 * deliberately literal: every step the executor recorded, in the order it
 * recorded them, with the arguments and the result it got back. Nothing is
 * summarised away, because the moment a trace starts editorialising is the
 * moment it stops being usable for working out why something went wrong.
 */
const ICONS: Record<string, typeof Cpu> = {
  model_call: Cpu,
  tool_call: Wrench,
  delegation: CornerDownRight,
  error: AlertCircle,
};

/**
 * Milliseconds under a second, seconds above it.
 *
 * A 32 ms run rendered as "0.0s" reads as "no data"; the whole point of the
 * duration column is telling a fast run from a stuck one.
 */
export const duration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

const label = (step: TraceStep): string => {
  const data = step.data as { tool?: string; action?: string; to?: string; model?: string };
  switch (step.type) {
    case "tool_call":
      return [data.tool, data.action].filter(Boolean).join(" · ") || "tool";
    case "delegation":
      return `delegated to ${data.to ?? "an agent"}`;
    case "model_call":
      return data.model ?? "model call";
    default:
      return step.type;
  }
};

/**
 * Long values are folded; nobody wants a 20 kB file body inline by default.
 *
 * The text is computed before any early return so the hook below always runs
 * — a payload that becomes empty between renders must not shift hook order.
 */
function Payload({ value }: { value: unknown }) {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  const long = text.length > 600;
  const [open, setOpen] = useState(!long);

  if (!text || text === "{}" || text === '""') return null;
  return (
    <div className="mt-2">
      {long && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mb-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {open ? "Hide" : `Show ${text.length.toLocaleString()} characters`}
        </button>
      )}
      {open && (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-2.5 text-[11.5px] leading-relaxed">
          {text}
        </pre>
      )}
    </div>
  );
}

function Step({ step }: { step: TraceStep }) {
  const data = step.data as {
    tool?: string;
    arguments?: unknown;
    output?: unknown;
    error?: string;
    ok?: boolean;
    executed?: boolean;
    effect?: string;
    content?: string;
    durationMs?: number;
    stopReason?: string;
    task?: string;
    result?: unknown;
    message?: string;
  };
  const Icon = ICONS[step.type] ?? Cpu;
  const failed = data.ok === false || step.type === "error";
  const skipped = data.executed === false;

  return (
    <li className="relative pl-8">
      {/* The rail that makes a long trace readable as a sequence. */}
      <span className="absolute left-[11px] top-6 bottom-0 w-px bg-border" aria-hidden />
      <span
        className={`absolute left-0 top-1 flex size-[22px] items-center justify-center rounded-full border bg-background ${
          failed ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground"
        }`}
      >
        {step.type === "tool_call" && data.tool ? (
          <ToolIcon tool={data.tool} className="size-3.5" />
        ) : (
          <Icon className="size-3.5" />
        )}
      </span>

      <div className="pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[11px] text-muted-foreground">{step.seq}</span>
          <span className="text-sm font-medium">{label(step)}</span>
          {step.agentName && (
            <Badge variant="outline" className="text-[10px]">
              {step.agentName}
            </Badge>
          )}
          {failed && (
            <Badge variant="destructive" className="text-[10px]">
              failed
            </Badge>
          )}
          {skipped && (
            <Badge variant="secondary" className="text-[10px]">
              {data.effect === "deny" ? "denied" : "skipped"}
            </Badge>
          )}
          {typeof data.durationMs === "number" && (
            <span className="text-[11px] text-muted-foreground">{data.durationMs} ms</span>
          )}
          {(step.inputTokens > 0 || step.outputTokens > 0) && (
            <span className="text-[11px] text-muted-foreground">
              {step.inputTokens.toLocaleString()} in / {step.outputTokens.toLocaleString()} out
            </span>
          )}
          {data.stopReason && (
            <span className="text-[11px] text-muted-foreground">{data.stopReason}</span>
          )}
        </div>

        {data.error && <p className="mt-1.5 text-[12.5px] text-destructive">{data.error}</p>}
        {data.message && <p className="mt-1.5 text-[12.5px] text-destructive">{data.message}</p>}
        {data.task && <p className="mt-1.5 text-[13px] text-muted-foreground">{data.task}</p>}
        {data.content && <Payload value={data.content} />}
        <Payload value={data.arguments} />
        <Payload value={data.output ?? data.result} />
      </div>
    </li>
  );
}

export function RunTrace({ activity }: { activity: RunActivity }) {
  const { run, steps, summary, approvals } = activity;

  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 border-b pb-4 sm:grid-cols-4">
        {[
          ["Cost", run.costUsd === null ? "unknown" : `$${Number(run.costUsd).toFixed(4)}`],
          ["Tokens", `${run.inputTokens.toLocaleString()} / ${run.outputTokens.toLocaleString()}`],
          ["Duration", duration(summary.durationMs)],
          ["Steps", `${summary.modelCalls} model · ${summary.toolCalls} tool`],
        ].map(([term, value]) => (
          <div key={term}>
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{term}</dt>
            <dd className="mt-0.5 text-sm tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {run.error && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="flex items-center gap-2 text-[13px] font-medium text-destructive">
            <AlertCircle className="size-4" /> This run failed
            {run.attempt > 1 && ` after ${run.attempt} attempts`}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">{run.error}</p>
        </div>
      )}

      {approvals.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {approvals.map((approval) => (
            <div
              key={approval.id}
              className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-[12.5px]"
            >
              <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">
                {approval.toolName} · {approval.action}
              </span>
              <Badge
                variant={
                  approval.status === "approved"
                    ? "default"
                    : approval.status === "denied"
                      ? "destructive"
                      : "secondary"
                }
                className="text-[10px]"
              >
                {approval.status}
              </Badge>
              {approval.reason && (
                <span className="truncate text-muted-foreground">{approval.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {steps.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No steps recorded — this run never reached the model.
        </p>
      ) : (
        <ol className="mt-6">
          {steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** The chevron a row uses to say it opens something. */
export const RowChevron = () => (
  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
);
