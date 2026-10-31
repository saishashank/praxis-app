// Layered auto-layout for one Blueprint view (D-365): one column per element type in a fixed order,
// rows sorted by id. Pure and deterministic: the same input always gives the same coordinates.
// An element with explicit x and y (spec map override) keeps them.
import type { BpEdge, BpElement } from "./types";

export const NODE_W = 200;
export const NODE_H = 48;
export const COL_GAP = 120;
export const ROW_GAP = 16;
export const PAD = 24;

export const TYPE_ORDER = [
  "host",
  "service",
  "page",
  "route",
  "action",
  "workflow",
  "agent",
  "slot",
  "llm-role",
  "llm-provider",
  "source",
  "group",
  "table",
  "secret",
];

export type LaidNode = { el: BpElement; x: number; y: number };
export type LaidEdge = { edge: BpEdge; x1: number; y1: number; x2: number; y2: number };
export type Layout = { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number };

const rank = (t: string): number => {
  const i = TYPE_ORDER.indexOf(t);
  return i < 0 ? TYPE_ORDER.length : i;
};
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function layoutView(viewId: string, elements: BpElement[], edges: BpEdge[]): Layout {
  const inView = elements.filter((e) => e.views.includes(viewId));
  const types = [...new Set(inView.map((e) => e.type))].sort(
    (a, b) => rank(a) - rank(b) || cmp(a, b),
  );
  const nodes: LaidNode[] = [];
  let height = 0;
  types.forEach((t, col) => {
    const rows = inView.filter((e) => e.type === t).sort((a, b) => cmp(a.id, b.id));
    rows.forEach((el, row) => {
      const x = typeof el.x === "number" ? el.x : PAD + col * (NODE_W + COL_GAP);
      const y = typeof el.y === "number" ? el.y : PAD + row * (NODE_H + ROW_GAP);
      nodes.push({ el, x, y });
      height = Math.max(height, y + NODE_H + PAD);
    });
  });
  const at = new Map(nodes.map((n) => [n.el.id, n]));
  const laid: LaidEdge[] = [];
  for (const edge of edges) {
    if (!edge.views.includes(viewId)) continue;
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b) continue;
    const right = b.x >= a.x;
    laid.push({
      edge,
      x1: right ? a.x + NODE_W : a.x,
      y1: a.y + NODE_H / 2,
      x2: right ? b.x : b.x + NODE_W,
      y2: b.y + NODE_H / 2,
    });
  }
  laid.sort((p, q) => cmp(p.edge.id, q.edge.id));
  const width = Math.max(PAD * 2 + NODE_W, ...nodes.map((n) => n.x + NODE_W + PAD));
  return { nodes, edges: laid, width, height: Math.max(height, PAD * 2 + NODE_H) };
}
