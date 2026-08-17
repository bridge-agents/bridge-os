import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type Approval, api, type SourceData, type Widget } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { ToolIcon } from "../ToolIcon.jsx";
import { Badge } from "../ui.jsx";
import { Chart } from "./Chart.jsx";

/**
 * The widget registry: schema `type` → React component.
 *
 * Two rules hold the whole renderer together.
 *
 * 1. A widget never decides what data it may read. It names a source; the
 *    server resolves it against a closed catalogue. An unknown source — which
 *    the schema permits, since `source` is just a string, and which an AI can
 *    therefore produce — comes back "unavailable" and renders as a labelled
 *    gap.
 * 2. A widget never invents data. A panel with nothing behind it says so.
 *    A dashboard that quietly shows zero is worse than one with a visible
 *    hole, because you cannot tell it apart from a real zero.
 */

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <Card className="h-full rounded-lg">
      {title && (
        <CardHeader className="pb-1">
          <CardTitle className="text-sm">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className={title ? undefined : "pt-0"}>{children}</CardContent>
    </Card>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return <p className="py-4 text-sm text-text-faint">{reason}</p>;
}

/** Load one source. Every data-bound widget goes through this. */
function useSource(workspaceId: string, source: string | undefined) {
  const [data, setData] = useState<SourceData | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;

    const load = () =>
      api
        .data(workspaceId, source)
        .then(({ data: resolved }) => !cancelled && setData(resolved))
        // A 404 means the document named a source that does not exist.
        .catch(() => !cancelled && setMissing(true));

    void load();
    const interval = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId, source]);

  return { data, missing };
}

function formatValue(value: number, unit?: string): string {
  if (unit === "usd") return `$${value.toFixed(value < 1 ? 4 : 2)}`;
  return value.toLocaleString();
}

function Metric({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  const source = "source" in widget ? widget.source : undefined;
  const { data, missing } = useSource(workspaceId, source);

  return (
    <Frame title={widget.title}>
      {missing ? (
        <Unavailable reason={`No source called "${source}".`} />
      ) : !data ? (
        <Skeleton className="h-8 w-28" />
      ) : data.kind === "metric" ? (
        <p className="font-condensed text-3xl font-semibold tracking-tight text-text">
          {formatValue(data.value, data.unit)}
          {data.unit === "tokens" && (
            <span className="ml-1.5 font-sans text-xs font-normal text-text-faint">tokens</span>
          )}
        </p>
      ) : (
        <Unavailable reason={`"${source}" is not a single number.`} />
      )}
    </Frame>
  );
}

function ChartWidget({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  const source = "source" in widget ? widget.source : undefined;
  const { data, missing } = useSource(workspaceId, source);
  const chartType = "chartType" in widget ? widget.chartType : "line";

  return (
    <Frame title={widget.title}>
      {missing ? (
        <Unavailable reason={`No source called "${source}".`} />
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : data.kind === "series" ? (
        <Chart points={data.points} chartType={chartType} unit={data.unit} />
      ) : (
        <Unavailable reason={`"${source}" has no series to plot.`} />
      )}
    </Frame>
  );
}

function Rows({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  const source = "source" in widget ? widget.source : undefined;
  const { data, missing } = useSource(workspaceId, source);

  if (missing) {
    return (
      <Frame title={widget.title}>
        <Unavailable reason={`No source called "${source}".`} />
      </Frame>
    );
  }
  if (!data) {
    return (
      <Frame title={widget.title}>
        <Skeleton className="h-16 w-full" />
      </Frame>
    );
  }
  if (data.kind !== "rows") {
    return (
      <Frame title={widget.title}>
        <Unavailable reason={`"${source}" is not tabular.`} />
      </Frame>
    );
  }
  if (data.rows.length === 0) {
    return (
      <Frame title={widget.title}>
        <p className="py-4 text-sm text-text-faint">Nothing yet.</p>
      </Frame>
    );
  }

  return (
    <Frame title={widget.title}>
      <div className="-mx-2">
        <Table>
          <TableHeader>
            <TableRow>
              {data.columns.map((column) => (
                <TableHead key={column} className="h-8 text-xs text-muted-foreground">
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => (
              <TableRow key={row.join("|")}>
                {row.map((cell, index) => (
                  <TableCell
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                    key={index}
                    className="max-w-[16rem] truncate font-mono text-xs text-muted-foreground"
                    title={String(cell ?? "")}
                  >
                    {cell ?? "-"}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Frame>
  );
}

/** Live approvals, so a dashboard can be the place you notice and act. */
function ApprovalQueue({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  const [pending, setPending] = useState<Approval[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .approvals(workspaceId)
        .then(({ approvals }) => !cancelled && setPending(approvals))
        .catch(() => !cancelled && setPending([]));
    void load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceId]);

  return (
    <Frame title={widget.title ?? "Approvals"}>
      {!pending ? (
        <Skeleton className="h-12 w-full" />
      ) : pending.length === 0 ? (
        <p className="py-2 text-sm text-text-faint">Nothing waiting.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pending.slice(0, 5).map((approval) => (
            <li key={approval.id} className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <ToolIcon tool={approval.toolName} className="size-5 rounded-sm" />
                <span className="truncate">
                  <span className="font-mono text-text">{approval.toolName}</span>
                  <span className="text-text-muted"> · {approval.action}</span>
                </span>
              </span>
              <Link
                to="/approvals"
                className="shrink-0 text-xs text-text-muted underline-offset-4 hover:text-text hover:underline"
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

function AgentStatus({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  const [agents, setAgents] = useState<{ id: string; name: string; status: string }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .agents(workspaceId)
      .then(({ agents: list }) => !cancelled && setAgents(list))
      .catch(() => !cancelled && setAgents([]));
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return (
    <Frame title={widget.title ?? "Agents"}>
      {!agents ? (
        <Skeleton className="h-12 w-full" />
      ) : agents.length === 0 ? (
        <p className="py-2 text-sm text-text-faint">No agents yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {agents.map((agent) => (
            <li key={agent.id} className="flex items-center justify-between gap-3">
              <Link
                to={`/agents/${agent.id}`}
                className="truncate text-sm text-text-muted hover:text-text"
              >
                {agent.name}
              </Link>
              <Badge tone={agent.status === "deployed" ? "success" : "neutral"}>
                {agent.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

function TextWidget({ widget }: { widget: Widget }) {
  const content = "content" in widget ? widget.content : "";
  return (
    <Frame title={widget.title}>
      <p className="whitespace-pre-wrap text-sm text-text-muted">{content}</p>
    </Frame>
  );
}

/**
 * Embeds render as a link, never an iframe. A dashboard can be written by a
 * model or imported with an agent, and silently framing a URL it chose would
 * hand a third-party page a window inside the app.
 */
function EmbedWidget({ widget }: { widget: Widget }) {
  const url = "url" in widget ? widget.url : "";
  return (
    <Frame title={widget.title}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="break-all font-mono text-xs text-text-muted underline-offset-4 hover:text-text hover:underline"
      >
        {url}
      </a>
      <span className="text-xs text-text-faint">Opens in a new tab.</span>
    </Frame>
  );
}

export function WidgetView({ workspaceId, widget }: { workspaceId: string; widget: Widget }) {
  switch (widget.type) {
    case "metric":
      return <Metric workspaceId={workspaceId} widget={widget} />;
    case "chart":
      return <ChartWidget workspaceId={workspaceId} widget={widget} />;
    case "table":
    case "activity":
    case "logs":
    case "taskList":
      return <Rows workspaceId={workspaceId} widget={widget} />;
    case "approvalQueue":
      return <ApprovalQueue workspaceId={workspaceId} widget={widget} />;
    case "agentStatus":
      return <AgentStatus workspaceId={workspaceId} widget={widget} />;
    case "text":
      return <TextWidget widget={widget} />;
    case "embed":
      return <EmbedWidget widget={widget} />;
    case "chat":
      return (
        <Frame title={widget.title ?? "Chat"}>
          <Button asChild variant="outline" size="sm">
            <Link to="/chat">Open chat</Link>
          </Button>
        </Frame>
      );
    default:
      // A widget type the schema allows but this renderer has not learned.
      return (
        <Frame title={widget.title}>
          <Unavailable reason="This widget is not available in this version." />
        </Frame>
      );
  }
}

/** Widgets that want the full width of a section rather than a grid cell. */
export function isWide(widget: Widget): boolean {
  return (
    widget.type === "table" ||
    widget.type === "activity" ||
    widget.type === "logs" ||
    widget.type === "taskList" ||
    widget.type === "chart"
  );
}
