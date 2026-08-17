import type { KnowledgeEdge, KnowledgeNode } from "./api.js";

/**
 * A force layout, in about sixty lines.
 *
 * Three forces, which is all a readable graph needs: linked nodes pull
 * together, every node pushes every other apart, and everything drifts gently
 * towards the middle so nothing escapes the frame. Running it here rather than
 * adding a graph library keeps the web bundle as it is — the maths is a few
 * lines and the tuning is the actual work either way.
 *
 * ponytail: O(n²) repulsion, recomputed every step. Fine to a few hundred
 * nodes; past that it wants a quadtree (Barnes–Hut).
 */
export interface Positioned {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How many links it has — bigger dots for better-connected ideas. */
  degree: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  steps?: number;
  /** Deterministic placement, so the same graph looks the same twice. */
  seed?: number;
}

/** Small deterministic PRNG: the layout must not shuffle on every render. */
function random(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

export function layoutGraph(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  options: LayoutOptions,
): Positioned[] {
  const { width, height, steps = 260 } = options;
  const next = random(options.seed ?? 42);
  const centreX = width / 2;
  const centreY = height / 2;

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
  }

  // Start on a circle rather than at random: it converges faster and never
  // begins with everything piled on one pixel.
  const placed: Positioned[] = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    const radius = Math.min(width, height) * 0.32 * (0.6 + next() * 0.4);
    return {
      id: node.id,
      x: centreX + Math.cos(angle) * radius,
      y: centreY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: degree.get(node.id) ?? 0,
    };
  });

  const byId = new Map(placed.map((node) => [node.id, node]));
  const links = edges
    .map((edge) => ({ from: byId.get(edge.fromId), to: byId.get(edge.toId) }))
    .filter((link): link is { from: Positioned; to: Positioned } => Boolean(link.from && link.to));

  const ideal = Math.max(70, Math.min(width, height) / Math.max(3, Math.sqrt(placed.length)));

  for (let step = 0; step < steps; step += 1) {
    // Cooling: big moves early, small corrections late.
    const heat = 1 - step / steps;

    for (let i = 0; i < placed.length; i += 1) {
      const a = placed[i];
      if (!a) continue;
      for (let j = i + 1; j < placed.length; j += 1) {
        const b = placed[j];
        if (!b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          // Exactly coincident points have no direction to separate along.
          dx = next() - 0.5;
          dy = next() - 0.5;
          distance = 0.01;
        }
        const push = (ideal * ideal) / (distance * distance) / 2;
        a.vx += (dx / distance) * push;
        a.vy += (dy / distance) * push;
        b.vx -= (dx / distance) * push;
        b.vy -= (dy / distance) * push;
      }
    }

    for (const link of links) {
      const dx = link.to.x - link.from.x;
      const dy = link.to.y - link.from.y;
      const distance = Math.max(0.01, Math.hypot(dx, dy));
      const pull = (distance - ideal) * 0.02;
      link.from.vx += (dx / distance) * pull;
      link.from.vy += (dy / distance) * pull;
      link.to.vx -= (dx / distance) * pull;
      link.to.vy -= (dy / distance) * pull;
    }

    for (const node of placed) {
      node.vx += (centreX - node.x) * 0.004;
      node.vy += (centreY - node.y) * 0.004;
      node.x += Math.max(-24, Math.min(24, node.vx * heat));
      node.y += Math.max(-24, Math.min(24, node.vy * heat));
      node.vx *= 0.82;
      node.vy *= 0.82;
      // Keep everything on screen, with room for the dot and its label.
      node.x = Math.max(24, Math.min(width - 24, node.x));
      node.y = Math.max(24, Math.min(height - 24, node.y));
    }
  }

  return placed;
}

/** Colour by what kind of thing it is, so the graph reads at a glance. */
export const KIND_COLOURS: Record<string, string> = {
  person: "#e0a458",
  project: "#5b9dd9",
  preference: "#b06fc9",
  event: "#5cb98b",
  fact: "#8a8f98",
};

export const kindColour = (kind: string) => KIND_COLOURS[kind] ?? KIND_COLOURS.fact ?? "#8a8f98";

/** Dot size: better-connected and better-believed ideas draw larger. */
export function nodeRadius(node: { degree: number }, confidence: number): number {
  return 6 + Math.min(8, node.degree * 1.6) + confidence * 3;
}
