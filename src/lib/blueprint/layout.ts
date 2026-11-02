// Page layout for one Blueprint view (D-365): the same layered layout the exports use
// (src/lib/blueprint/export.ts: COLUMN_ORDER, elements sorted by name then id), with node-side
// coordinates for the edges. Pure and deterministic.
import { COLUMN_ORDER, layoutView as exportLayout } from "./export";
import type { BpEdge, BpElement, BpModel } from "./types";

export { COLUMN_ORDER };
export const NODE_W = 200;
export const NODE_H = 40;

export type LaidNode = { el: BpElement; x: number; y: number };
export type LaidEdge = { edge: BpEdge; x1: number; y1: number; x2: number; y2: number };
export type Layout = { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number };

export function layoutView(viewId: string, elements: BpElement[], edges: BpEdge[]): Layout {
  const model = { views: [{ id: viewId, name: viewId }], elements, edges } as unknown as BpModel;
  const laid = exportLayout(model, viewId);
  const byCell = new Map(laid.nodes.map((n) => [n.cell, n]));
  const nodes = laid.nodes.map((n) => ({ el: n.el as BpElement, x: n.x, y: n.y }));
  const out: LaidEdge[] = [];
  for (const g of laid.edges) {
    const a = byCell.get(g.from)!;
    const b = byCell.get(g.to)!;
    const right = b.x >= a.x;
    out.push({
      edge: g.edge as BpEdge,
      x1: right ? a.x + NODE_W : a.x,
      y1: a.y + NODE_H / 2,
      x2: right ? b.x : b.x + NODE_W,
      y2: b.y + NODE_H / 2,
    });
  }
  return { nodes, edges: out, width: laid.width, height: laid.height };
}
