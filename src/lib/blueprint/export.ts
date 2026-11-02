// Blueprint export (M16 WP6; UXN-299, AT-59 b, D-368). Pure functions: no I/O, no clock, no random.
// toDrawio gives mxGraph XML (opens in draw.io desktop); toSvg gives a standalone SVG with no external
// references. Both draw the same layered layout: one column per element type, in a fixed order,
// elements sorted by name then id, so the same model and view always give the same bytes.
// The model holds names and structure only (SEC-113); nothing here adds data from outside it.

export type ExportElement = { id: string; type: string; name: string; views: readonly string[] };
export type ExportEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  views: readonly string[];
};
export type ExportModel = {
  views: readonly { id: string; name: string }[];
  elements: readonly ExportElement[];
  edges: readonly ExportEdge[];
};

/** Column order of the page and of both exports (left to right). */
export const COLUMN_ORDER: readonly string[] = [
  "service",
  "page",
  "route",
  "action",
  "workflow",
  "slot",
  "agent",
  "llm-role",
  "llm-provider",
  "source",
  "host",
  "secret",
  "table",
  "group",
];

const NODE_W = 200;
const NODE_H = 40;
const GAP_X = 80;
const GAP_Y = 20;
const MARGIN = 40;

export type Placed = { el: ExportElement; x: number; y: number; cell: string };
export type Laid = {
  nodes: Placed[];
  edges: { edge: ExportEdge; cell: string; from: string; to: string }[];
  width: number;
  height: number;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The view's elements and edges with positions and deterministic cell ids (n1.., e1..). */
export function layoutView(model: ExportModel, view: string): Laid {
  const els = model.elements
    .filter((e) => e.views.includes(view))
    .sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id));
  const cols = COLUMN_ORDER.filter((t) => els.some((e) => e.type === t));
  for (const e of els) if (!cols.includes(e.type)) cols.push(e.type);
  const rowOf = new Map<string, number>();
  const nodes: Placed[] = els.map((el, i) => {
    const col = cols.indexOf(el.type);
    const row = rowOf.get(el.type) ?? 0;
    rowOf.set(el.type, row + 1);
    return {
      el,
      x: MARGIN + col * (NODE_W + GAP_X),
      y: MARGIN + row * (NODE_H + GAP_Y),
      cell: `n${i + 1}`,
    };
  });
  const cellOf = new Map(nodes.map((n) => [n.el.id, n.cell]));
  const edges = model.edges
    .filter((e) => e.views.includes(view) && cellOf.has(e.from) && cellOf.has(e.to))
    .sort((a, b) => byText(a.id, b.id))
    .map((edge, i) => ({
      edge,
      cell: `e${i + 1}`,
      from: cellOf.get(edge.from)!,
      to: cellOf.get(edge.to)!,
    }));
  const maxRows = Math.max(1, ...rowOf.values());
  return {
    nodes,
    edges,
    width: MARGIN * 2 + Math.max(1, cols.length) * (NODE_W + GAP_X) - GAP_X,
    height: MARGIN * 2 + maxRows * (NODE_H + GAP_Y) - GAP_Y,
  };
}

function viewName(model: ExportModel, view: string): string {
  const v = model.views.find((x) => x.id === view);
  if (!v) throw new Error(`unknown view ${view}`);
  return v.name;
}

/** XML attribute / text escape; also drops characters XML 1.0 cannot hold. */
export function esc(s: string): string {
  return s
    .replace(/[^\u0009\u000A\u000D -퟿-�]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;");
}

export function toDrawio(model: ExportModel, view: string): string {
  const name = viewName(model, view);
  const laid = layoutView(model, view);
  const out: string[] = [];
  out.push(`<mxfile host="praxis-blueprint" version="1">`);
  out.push(`  <diagram id="view-${esc(view)}" name="${esc(name)}">`);
  out.push(
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${laid.width}" pageHeight="${laid.height}" math="0" shadow="0">`,
  );
  out.push(`      <root>`);
  out.push(`        <mxCell id="0"/>`);
  out.push(`        <mxCell id="1" parent="0"/>`);
  for (const n of laid.nodes) {
    out.push(
      `        <mxCell id="${n.cell}" value="${esc(n.el.name)}" tooltip="${esc(n.el.id)}" style="rounded=1;whiteSpace=wrap;html=0;" vertex="1" parent="1">`,
      `          <mxGeometry x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" as="geometry"/>`,
      `        </mxCell>`,
    );
  }
  for (const e of laid.edges) {
    out.push(
      `        <mxCell id="${e.cell}" value="${esc(e.edge.kind)}" style="endArrow=classic;html=0;" edge="1" parent="1" source="${e.from}" target="${e.to}">`,
      `          <mxGeometry relative="1" as="geometry"/>`,
      `        </mxCell>`,
    );
  }
  out.push(`      </root>`, `    </mxGraphModel>`, `  </diagram>`, `</mxfile>`);
  return out.join("\n") + "\n";
}

const fit = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + "…" : s);

export function toSvg(model: ExportModel, view: string): string {
  const name = viewName(model, view);
  const laid = layoutView(model, view);
  const pos = new Map(laid.nodes.map((n) => [n.cell, n]));
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${laid.width}" height="${laid.height}" viewBox="0 0 ${laid.width} ${laid.height}" font-family="sans-serif" font-size="12">`,
    `  <title>${esc(name)}</title>`,
    `  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#64748b"/></marker></defs>`,
    `  <rect width="${laid.width}" height="${laid.height}" fill="#ffffff"/>`,
  );
  for (const e of laid.edges) {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    const forward = b.x >= a.x;
    const x1 = a.x + (forward ? NODE_W : 0);
    const x2 = b.x + (forward ? 0 : NODE_W);
    out.push(
      `  <line id="${e.cell}" x1="${x1}" y1="${a.y + NODE_H / 2}" x2="${x2}" y2="${b.y + NODE_H / 2}" stroke="#64748b" stroke-width="1" marker-end="url(#arrow)"><title>${esc(e.edge.kind)}</title></line>`,
    );
  }
  for (const n of laid.nodes) {
    out.push(
      `  <g id="${n.cell}"><title>${esc(n.el.id)}</title><rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="6" fill="#f1f5f9" stroke="#334155"/><text x="${n.x + NODE_W / 2}" y="${n.y + NODE_H / 2 + 4}" text-anchor="middle" fill="#0f172a">${esc(fit(n.el.name, 28))}</text></g>`,
    );
  }
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
