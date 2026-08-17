/**
 * biome-ignore-all lint/a11y/noStaticElementInteractions: the dots are a
 * drawing, and an SVG group pretending to be a button is a lie to a screen
 * reader. Keyboard and assistive access is the visually hidden list of real
 * buttons rendered beside the graph, driving the same selection.
 */
import { Link2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeEdge, KnowledgeNode } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { kindColour, layoutGraph, nodeRadius } from "../knowledgeGraph.js";
import { EmptyState } from "../ui.jsx";

interface Props {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  canAdmin: boolean;
  onForget: (nodeId: string) => void;
}

/**
 * Knowledge as a map rather than a list.
 *
 * A table of remembered facts answers "what is in there" and nothing else. The
 * useful questions about memory are shaped like a graph — what is this
 * connected to, what does the agent think matters, where is the cluster it has
 * built up about one project — so that is what this draws. Clicking a point
 * opens it beside the map rather than replacing it, because the connections
 * are the context for what you just clicked.
 */
export function KnowledgeGraphView({ nodes, edges, canAdmin, onForget }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Redraw to fit whatever room the panel leaves.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: Math.max(320, entry.contentRect.width),
        height: Math.max(360, entry.contentRect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const positions = useMemo(
    () => layoutGraph(nodes, edges, { width: size.width, height: size.height }),
    [nodes, edges, size.width, size.height],
  );
  const byId = useMemo(() => new Map(positions.map((node) => [node.id, node])), [positions]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const connections = useMemo(() => {
    if (!selectedId) return [];
    return edges
      .filter((edge) => edge.fromId === selectedId || edge.toId === selectedId)
      .map((edge) => ({
        relation: edge.relation,
        other: nodeById.get(edge.fromId === selectedId ? edge.toId : edge.fromId),
        outgoing: edge.fromId === selectedId,
      }))
      .filter((link) => link.other);
  }, [edges, selectedId, nodeById]);

  /** Everything one hop from what is selected or hovered stays lit. */
  const focusId = hoverId ?? selectedId;
  const near = useMemo(() => {
    if (!focusId) return null;
    const set = new Set([focusId]);
    for (const edge of edges) {
      if (edge.fromId === focusId) set.add(edge.toId);
      if (edge.toId === focusId) set.add(edge.fromId);
    }
    return set;
  }, [edges, focusId]);

  if (nodes.length === 0) {
    return (
      <EmptyState title="Nothing known yet">
        <span className="inline-flex items-center gap-2">
          <Link2 className="size-4" /> Knowledge is gathered from conversations a few at a time, not
          after every message. Talk to an agent with memory on and this fills in.
        </span>
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-[32rem] gap-3">
      <div ref={frame} className="relative min-w-0 flex-1 rounded-lg border bg-muted/10">
        <svg
          width={size.width}
          height={size.height}
          className="touch-none select-none"
          role="img"
          aria-label="Knowledge graph"
        >
          <title>What this workspace's agents know, and how it connects</title>
          {edges.map((edge) => {
            const from = byId.get(edge.fromId);
            const to = byId.get(edge.toId);
            if (!from || !to) return null;
            const lit = !near || (near.has(edge.fromId) && near.has(edge.toId));
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="currentColor"
                className={lit ? "text-muted-foreground" : "text-muted-foreground/30"}
                strokeWidth={lit ? 1.2 : 0.6}
              />
            );
          })}

          {positions.map((position) => {
            const node = nodeById.get(position.id);
            if (!node) return null;
            const lit = !near || near.has(node.id);
            const radius = nodeRadius(position, Number(node.confidence ?? 0.5));
            return (
              <g
                key={node.id}
                transform={`translate(${position.x} ${position.y})`}
                className="cursor-pointer"
                opacity={lit ? 1 : 0.35}
                onClick={() => setSelectedId(node.id)}
                onMouseEnter={() => setHoverId(node.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <circle
                  r={radius}
                  fill={kindColour(node.kind)}
                  stroke={selectedId === node.id ? "currentColor" : "none"}
                  strokeWidth={2}
                  className="text-foreground"
                />
                <text
                  y={radius + 12}
                  textAnchor="middle"
                  className="pointer-events-none fill-foreground text-[10px]"
                >
                  {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
                </text>
              </g>
            );
          })}
        </svg>

        {/* The same points, reachable without a mouse: a drawing cannot be
            tabbed through, and an SVG group pretending to be a button is a lie
            to a screen reader. Both drive the same selection. */}
        <ul className="sr-only">
          {nodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => setSelectedId(node.id)}>
                {node.title} — {node.kind}. {node.body}
              </button>
            </li>
          ))}
        </ul>

        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
          {["person", "project", "preference", "event", "fact"].map((kind) => (
            <span key={kind} className="flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: kindColour(kind) }}
              />
              {kind}
            </span>
          ))}
        </div>
      </div>

      {selected && (
        <aside className="w-80 shrink-0 overflow-y-auto rounded-lg border bg-background p-4">
          <div className="mb-3 flex items-start justify-between gap-2">
            <div>
              <Badge variant="outline" style={{ borderColor: kindColour(selected.kind) }}>
                {selected.kind}
              </Badge>
              <h3 className="mt-2 text-base font-semibold leading-tight">{selected.title}</h3>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSelectedId(null)}>
              <X />
            </Button>
          </div>

          <p className="text-sm leading-relaxed">{selected.body}</p>

          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
            <div>
              <dt>Confidence</dt>
              <dd className="text-foreground">
                {Math.round(Number(selected.confidence ?? 0.5) * 100)}%
              </dd>
            </div>
            <div>
              <dt>Mentioned</dt>
              <dd className="text-foreground">
                {selected.mentions} {selected.mentions === 1 ? "time" : "times"}
              </dd>
            </div>
            <div>
              <dt>Agent</dt>
              <dd className="text-foreground">{selected.agentName}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd className="text-foreground">
                {new Date(selected.updatedAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>

          {connections.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-medium text-muted-foreground">Connected to</h4>
              <ul className="space-y-1">
                {connections.map((link) => (
                  <li key={`${link.other?.id}-${link.relation}`}>
                    <button
                      type="button"
                      className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                      onClick={() => link.other && setSelectedId(link.other.id)}
                    >
                      <span className="text-muted-foreground">
                        {link.outgoing ? link.relation : `${link.relation} ←`}{" "}
                      </span>
                      {link.other?.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="mt-5 w-full"
              onClick={() => {
                onForget(selected.id);
                setSelectedId(null);
              }}
            >
              <Trash2 /> Forget this
            </Button>
          )}
        </aside>
      )}
    </div>
  );
}
