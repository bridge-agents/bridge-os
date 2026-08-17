import { describe, expect, it } from "vitest";
import type { KnowledgeEdge, KnowledgeNode } from "./api.js";
import { kindColour, layoutGraph, nodeRadius } from "./knowledgeGraph.js";

const node = (id: string): KnowledgeNode => ({
  id,
  agentId: "agt_1",
  agentName: "Assistant",
  title: id,
  kind: "fact",
  body: "something",
  confidence: "0.7",
  mentions: 1,
  sourceRunId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const edge = (from: string, to: string): KnowledgeEdge => ({
  id: `${from}-${to}`,
  fromId: from,
  toId: to,
  relation: "related to",
});

const frame = { width: 800, height: 600 };

describe("laying out the graph", () => {
  it("keeps every point on the canvas", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => node(`n${index}`));
    const placed = layoutGraph(nodes, [], frame);

    expect(placed).toHaveLength(40);
    for (const point of placed) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(frame.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(frame.height);
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it("puts linked points nearer than unlinked ones", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const placed = layoutGraph(nodes, [edge("a", "b")], frame);
    const [a, b, c] = placed;
    if (!a || !b || !c) throw new Error("layout dropped a node");

    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(Math.hypot(a.x - c.x, a.y - c.y));
  });

  it("does not pile coincident points on one another", () => {
    const placed = layoutGraph([node("a"), node("b")], [], frame);
    const [a, b] = placed;
    if (!a || !b) throw new Error("layout dropped a node");
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20);
  });

  it("is stable: the same graph lays out the same way twice", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("a", "b")];
    expect(layoutGraph(nodes, edges, frame)).toEqual(layoutGraph(nodes, edges, frame));
  });

  it("survives an empty graph and an edge to nowhere", () => {
    expect(layoutGraph([], [], frame)).toEqual([]);
    expect(layoutGraph([node("a")], [edge("a", "missing")], frame)).toHaveLength(1);
  });

  it("draws better-connected, better-believed points larger", () => {
    expect(nodeRadius({ degree: 5 }, 1)).toBeGreaterThan(nodeRadius({ degree: 0 }, 0.2));
  });

  it("gives every kind a colour, including one it has never seen", () => {
    expect(kindColour("person")).not.toBe(kindColour("project"));
    expect(kindColour("something-new")).toBe(kindColour("fact"));
  });
});
