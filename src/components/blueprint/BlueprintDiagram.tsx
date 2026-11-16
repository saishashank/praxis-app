"use client";
// Blueprint diagram (M16 WP5, UXN-297/298, D-365). Fetches the model from the pinned-Owner API (the
// URL is a prop from the server page; the model is never bundled, D-372), lays out one view with the
// layered auto-layout, and draws it as inline SVG with pan, zoom, hover summary, search and a side
// panel (Sheet: bottom sheet on phones). Config keys are shown read-only. Keyboard (M21 C6, UXN-324 a, D-1320 to D-1324):
// one tab stop among the nodes (roving), arrows move between nodes, Home and End jump, Enter and Space open the panel,
// Escape returns to the viewport; edges are reached from the panel's connection buttons.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Card } from "@/components/ui/Card";
import { Segmented } from "@/components/ui/Segmented";
import { Pill } from "@/components/ui/Pill";
import { Sheet } from "@/components/ui/Sheet";
import { layoutView, NODE_H, NODE_W } from "@/lib/blueprint/layout";
import { searchElements } from "@/lib/blueprint/search";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BlueprintStatus, ElementStatus } from "@/lib/ui/loaders/blueprint";
import type { BpEdge, BpElement, BpModel } from "@/lib/blueprint/types";

type Tf = { x: number; y: number; k: number };
const K_MIN = 0.1;
const K_MAX = 3;
const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));

/** Reading order of a view: columns left to right, rows top to bottom. */
const reading = <T extends { x: number; y: number }>(a: T[]): T[] =>
  [...a].sort((p, q) => p.x - q.x || p.y - q.y);

/**
 * The node a navigation key moves to (D-1320). Left and right go to the adjacent column, to the row nearest in height;
 * up and down stay in the column and stop at its ends; Home and End are the first and last in reading order. Every
 * node is reachable this way. Returns null for any other key.
 */
export function moveFocus(
  nodes: Array<{ id: string; x: number; y: number }>,
  from: string,
  key: string,
): string | null {
  const cur = nodes.find((n) => n.id === from);
  if (!cur || nodes.length === 0) return null;
  const order = reading(nodes);
  if (key === "Home") return order[0].id;
  if (key === "End") return order[order.length - 1].id;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const col = order.filter((n) => n.x === cur.x);
    const i = col.findIndex((n) => n.id === from);
    return col[Math.max(0, Math.min(col.length - 1, i + (key === "ArrowDown" ? 1 : -1)))].id;
  }
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const xs = Array.from(new Set(order.map((n) => n.x)));
    const nx =
      key === "ArrowRight" ? xs.find((x) => x > cur.x) : [...xs].reverse().find((x) => x < cur.x);
    if (nx === undefined) return cur.id;
    const col = order.filter((n) => n.x === nx);
    return col.reduce((best, n) => (Math.abs(n.y - cur.y) < Math.abs(best.y - cur.y) ? n : best))
      .id;
  }
  return null;
}

/** A plain link to the export route: a download, so no client navigation (D-1323). The href comes from page code. */
function ExportLink({
  href,
  id,
  children,
}: {
  href: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className="underline" data-testid={`bp-export-${id}`}>
      {children}
    </a>
  );
}

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="text-text-muted">None</span>;
  return (
    <ul className="m-0 list-none p-0">
      {items.map((s) => (
        <li key={s} className="break-all">
          {s}
        </li>
      ))}
    </ul>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <dt className="text-xs font-semibold text-text-muted">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  );
}

const PILL: Record<string, string> = {
  ok: "ok",
  warn: "warn",
  fail: "bad",
  off: "neutral",
  unknown: "neutral",
};
const UNKNOWN: ElementStatus = { state: "unknown", detail: "No live status is kept for this." };

function ElementPanel({
  el,
  edges,
  names,
  status,
  onEdge,
}: {
  el: BpElement;
  edges: BpEdge[];
  names: Map<string, string>;
  status: BlueprintStatus;
  onEdge: (g: BpEdge | null) => void;
}) {
  const st = status.statuses[el.id] ?? UNKNOWN;
  const mine = edges.filter((g) => g.from === el.id || g.to === el.id);
  return (
    <div data-testid="bp-panel">
      <dl className="m-0">
        <Field label="Type">{el.type}</Field>
        <Field label="Purpose">{el.purpose}</Field>
        <Field label="Spec IDs">
          <span data-testid="bp-panel-specs">
            {el.specIds.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : ""}
                <Link href={`?tab=spec&q=${encodeURIComponent(id)}`} className="underline">
                  {id}
                </Link>
              </span>
            ))}
          </span>
        </Field>
        <Field label="Status">
          <span data-testid="bp-panel-status">
            <Pill kind="status" value={PILL[st.state] ?? "neutral"}>
              {st.state === "fail" ? "Failing" : st.state[0].toUpperCase() + st.state.slice(1)}
            </Pill>{" "}
            {st.detail}
            {st.lastRunAt ? ` Last run ${st.lastRunAt}.` : ""}
          </span>
        </Field>
        <Field label="Owner">{el.owner}</Field>
        <Field label="Schedule">{el.schedule ?? "None"}</Field>
        <Field label="Inputs">
          <List items={el.inputs} />
        </Field>
        <Field label="Outputs">
          <List items={el.outputs} />
        </Field>
        <Field label="Config keys and current values (read-only)">
          {el.configKeys.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <ul className="m-0 list-none p-0" data-testid="bp-panel-config">
              {el.configKeys.map((k) => {
                const v = status.config[el.id]?.find((c) => c.key === k);
                return (
                  <li key={k} className="break-all">
                    {k}:{" "}
                    {v ? <code>{v.value}</code> : <span className="text-text-muted">no value</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Field>
        {status.runs[el.id] ? (
          <Field label="Recent runs (last 5)">
            {status.runs[el.id].length === 0 ? (
              <span className="text-text-muted">No run recorded yet.</span>
            ) : (
              <ul className="m-0 list-none p-0" data-testid="bp-panel-runs">
                {status.runs[el.id].map((r, i) => (
                  <li key={i}>
                    {r.at}: {r.status}, {r.items} items
                    {r.durationMs === null ? "" : `, ${r.durationMs} ms`}
                  </li>
                ))}
              </ul>
            )}
          </Field>
        ) : null}
        {status.licences[el.id] ? (
          <Field label="Licence (source register)">
            <ul className="m-0 list-none p-0" data-testid="bp-panel-licence">
              <li>Status: {status.licences[el.id].status}</li>
              <li>Risk: {status.licences[el.id].risk}</li>
              <li>Permitted use: {status.licences[el.id].permittedUse ?? "not recorded"}</li>
              <li>Rate limits: {status.licences[el.id].rateLimits ?? "not recorded"}</li>
              <li>Last checked: {status.licences[el.id].lastChecked ?? "never"}</li>
              <li>
                Summarisation:{" "}
                {status.licences[el.id].summarisationPermitted ? "permitted" : "not permitted"}
              </li>
            </ul>
          </Field>
        ) : null}
        <Field label="Tables">
          <List items={el.tables} />
        </Field>
        <Field label="Failure behaviour">{el.failure}</Field>
        <Field label="Runbook">{el.runbook ?? "None"}</Field>
        <Field label="Source">{el.source ?? "None"}</Field>
        <Field label="Connections">
          {mine.length === 0 ? (
            <span className="text-text-muted">None</span>
          ) : (
            <ul className="m-0 list-none p-0">
              {mine.map((g) => (
                <li key={g.id} className="mb-1 break-words">
                  <button
                    type="button"
                    data-testid="bp-connection"
                    onFocus={() => onEdge(g)}
                    onBlur={() => onEdge(null)}
                    onPointerEnter={() => onEdge(g)}
                    onPointerLeave={() => onEdge(null)}
                    className="min-h-11 w-full rounded border border-border bg-transparent px-2 py-1 text-left text-sm text-text"
                  >
                    {g.from === el.id ? "to" : "from"} {names.get(g.from === el.id ? g.to : g.from)}{" "}
                    ({g.kind}): {g.contract}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
    </div>
  );
}

export function BlueprintDiagram({
  modelUrl,
  exportUrl,
  status,
}: {
  modelUrl: string;
  exportUrl: string;
  status: BlueprintStatus;
}) {
  const router = useRouter();
  const [model, setModel] = useState<BpModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState("platform");
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<BpEdge | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [rover, setRover] = useState<string | null>(null);
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [manual, setManual] = useState<{ view: string; tf: Tf } | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(modelUrl, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<BpModel>) : Promise.reject(new Error("load"))))
      .then((m) => live && setModel(m))
      .catch(() => live && setError("The architecture model could not be loaded."));
    return () => {
      live = false;
    };
  }, [modelUrl]);

  const layout = useMemo(
    () => (model ? layoutView(view, model.elements, model.edges) : null),
    [model, view],
  );
  const byId = useMemo(() => new Map((model?.elements ?? []).map((e) => [e.id, e])), [model]);
  const names = useMemo(() => new Map((model?.elements ?? []).map((e) => [e.id, e.name])), [model]);
  const results = useMemo(() => searchElements(model?.elements ?? [], query), [model, query]);
  const hits = useMemo(() => new Set(results.map((e) => e.id)), [results]);

  const [vw, setVw] = useState(600);
  const ready = layout !== null;
  useEffect(() => {
    const el = box.current;
    if (!el || !ready) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  // The view starts fitted to the width; any pan or zoom becomes a manual transform for this view.
  const fitTf = useMemo<Tf>(
    () => ({ x: 0, y: 0, k: clampK(Math.min(1, vw / (layout?.width ?? vw))) }),
    [layout, vw],
  );
  const tf = manual && manual.view === view ? manual.tf : fitTf;
  const setTf = useCallback(
    (f: (t: Tf) => Tf) => setManual((m) => ({ view, tf: f(m && m.view === view ? m.tf : fitTf) })),
    [view, fitTf],
  );
  const fit = () => setManual(null);

  // Zoom with ctrl/cmd + wheel needs a non-passive listener; a plain wheel keeps scrolling the page.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setTf((t) => ({ ...t, k: clampK(t.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [layout, setTf]);

  const open = (id: string) => {
    setSelected(id);
    setPanelOpen(true);
  };
  const pick = (el: BpElement) => {
    if (!el.views.includes(view)) setView(el.views[0]);
    open(el.id);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = 40;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
    } else if (e.key === "+" || e.key === "=") setTf((t) => ({ ...t, k: clampK(t.k * 1.2) }));
    else if (e.key === "-") setTf((t) => ({ ...t, k: clampK(t.k / 1.2) }));
    else if (e.key === "0") fit();
  };

  // Bring a node into the visible part of the viewport after a key moved focus to it (D-1320).
  const reveal = (n: { x: number; y: number }) => {
    const h = box.current?.clientHeight ?? 0;
    if (h === 0) return;
    const sx = tf.x + n.x * tf.k;
    const sy = tf.y + n.y * tf.k;
    const w = NODE_W * tf.k;
    const hh = NODE_H * tf.k;
    const dx = sx < 0 ? -sx + 8 : sx + w > vw ? vw - (sx + w) - 8 : 0;
    const dy = sy < 0 ? -sy + 8 : sy + hh > h ? h - (sy + hh) - 8 : 0;
    if (dx !== 0 || dy !== 0) setTf((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
  };
  const onNodeKey = (e: KeyboardEvent<SVGGElement>, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open(id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      box.current?.focus();
      return;
    }
    const to = layout
      ? moveFocus(
          layout.nodes.map((n) => ({ id: n.el.id, x: n.x, y: n.y })),
          id,
          e.key,
        )
      : null;
    if (to === null) return;
    e.preventDefault();
    const target = layout!.nodes.find((n) => n.el.id === to)!;
    setRover(to);
    nodeRefs.current.get(to)?.focus({ preventScroll: true });
    reveal(target);
  };

  if (error)
    return (
      <Card title="Blueprint">
        <p role="alert">{error}</p>
      </Card>
    );
  if (!model || !layout)
    return (
      <Card title="Blueprint">
        <p>Loading the architecture model.</p>
      </Card>
    );

  const hovered = hover ? byId.get(hover) : null;
  const tabs = [
    ...model.views.map((v) => ({ value: v.id, label: v.name })),
    { value: "spec", label: "Spec" },
  ];
  const viewName = model.views.find((v) => v.id === view)?.name ?? view;
  const selectedEl = selected ? byId.get(selected) : null;
  // The one tab stop among the nodes: the node last focused by key, else the open one, else the first (D-1320).
  const inView = (id: string | null) => id !== null && layout.nodes.some((n) => n.el.id === id);
  const stopId = inView(rover)
    ? rover
    : inView(selected)
      ? selected
      : (reading(layout.nodes.map((n) => ({ id: n.el.id, x: n.x, y: n.y })))[0]?.id ?? null);
  const exportHref = (format: string) => `${exportUrl}?view=${view}&format=${format}`;
  const zoomButtons: Array<[string, () => void, string]> = [
    ["Zoom in", () => setTf((t) => ({ ...t, k: clampK(t.k * 1.25) })), "+"],
    ["Zoom out", () => setTf((t) => ({ ...t, k: clampK(t.k / 1.25) })), "−"],
    ["Fit view", fit, "Fit"],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="bp-root">
      <Segmented
        label="Blueprint views"
        items={tabs}
        value={view}
        onChange={(v) => (v === "spec" ? router.push("?tab=spec") : setView(v))}
      />
      <Card
        title={viewName}
        actions={
          <span className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
            <span>
              {layout.nodes.length} elements, {layout.edges.length} connections
            </span>
            <ExportLink href={exportHref("drawio")} id="drawio">
              Export as draw.io
            </ExportLink>
            <ExportLink href={exportHref("svg")} id="svg">
              Export as SVG
            </ExportLink>
          </span>
        }
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col text-sm">
            <span className="mb-1 font-semibold">Search by name or spec ID</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-11 w-full rounded-lg border border-border bg-bg px-3 text-text"
              data-testid="bp-search"
              autoComplete="off"
            />
          </label>
          <div className="flex gap-2" role="group" aria-label="Zoom">
            {zoomButtons.map(([label, fn, text]) => (
              <button
                key={label}
                type="button"
                aria-label={label}
                onClick={fn}
                className="min-h-11 min-w-11 rounded-lg border border-border bg-surface px-3 text-text"
              >
                {text}
              </button>
            ))}
          </div>
        </div>
        {query.trim() !== "" ? (
          <ul
            className="mb-3 max-h-48 list-none overflow-y-auto p-0"
            data-testid="bp-results"
            aria-label="Search results"
          >
            {results.length === 0 ? (
              <li className="text-sm text-text-muted">No element matches.</li>
            ) : (
              results.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => pick(e)}
                    className="min-h-11 w-full rounded bg-transparent px-2 text-left text-sm break-words text-text hover:bg-bg"
                  >
                    {e.name}{" "}
                    <span className="text-text-muted">
                      ({e.type}; {e.specIds.join(", ")})
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
        <p className="mb-2 min-h-10 text-sm" data-testid="bp-summary" aria-live="polite">
          {hovered ? (
            <>
              <strong>{hovered.name}</strong> ({hovered.type}): {hovered.purpose}
            </>
          ) : hoverEdge ? (
            <>
              <strong>{hoverEdge.kind}</strong>: {hoverEdge.contract || "No contract text."}
            </>
          ) : (
            <span className="text-text-muted">
              Hover or focus an element for a summary; select it for details. Drag to pan; arrow
              keys pan; plus and minus zoom. With an element focused, arrow keys move between
              elements, Home and End jump to the first and last, Enter opens its details and Escape
              returns to the diagram.
            </span>
          )}
        </p>
        <div
          ref={box}
          tabIndex={0}
          role="group"
          aria-label={`${viewName} diagram`}
          onKeyDown={onKey}
          className="max-w-full overflow-hidden rounded-lg border border-border bg-bg"
          style={{ height: "min(70vh, 640px)" }}
          data-testid="bp-viewport"
        >
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            style={{ touchAction: "none", cursor: "grab" }}
            onPointerDown={(e) => {
              if ((e.target as Element).closest("[data-node]")) return;
              drag.current = { px: e.clientX, py: e.clientY, x: tf.x, y: tf.y };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              setTf((t) => ({ ...t, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          >
            <g transform={`translate(${tf.x} ${tf.y}) scale(${tf.k})`}>
              {layout.edges.map((g) => {
                const mx = (g.x1 + g.x2) / 2;
                const d = `M${g.x1} ${g.y1} C${mx} ${g.y1} ${mx} ${g.y2} ${g.x2} ${g.y2}`;
                const lit = hoverEdge?.id === g.edge.id;
                return (
                  <g
                    key={g.edge.id}
                    data-edge={g.edge.id}
                    data-edge-active={lit ? "true" : undefined}
                    role="img"
                    aria-label={`${g.edge.kind} connection from ${names.get(g.edge.from)} to ${names.get(g.edge.to)}`}
                    onPointerEnter={() => setHoverEdge(g.edge)}
                    onPointerLeave={() => setHoverEdge(null)}
                  >
                    <path
                      d={d}
                      fill="none"
                      stroke={lit ? "var(--color-accent)" : "var(--color-text-muted)"}
                      strokeWidth={lit ? 3 : 1.5}
                      opacity={lit ? 1 : 0.7}
                    />
                    <path d={d} fill="none" stroke="transparent" strokeWidth={10} />
                  </g>
                );
              })}
              {layout.nodes.map(({ el, x, y }) => {
                const on = el.id === selected;
                const dim = query.trim() !== "" && !hits.has(el.id);
                const label = el.name.length > 24 ? `${el.name.slice(0, 23)}…` : el.name;
                const act = () => open(el.id);
                return (
                  <g
                    key={el.id}
                    data-node={el.id}
                    role="button"
                    aria-pressed={on}
                    aria-label={`${el.name}, ${el.type}`}
                    ref={(g) => {
                      if (g) nodeRefs.current.set(el.id, g);
                      else nodeRefs.current.delete(el.id);
                    }}
                    tabIndex={el.id === stopId ? 0 : -1}
                    transform={`translate(${x} ${y})`}
                    opacity={dim ? 0.35 : 1}
                    style={{ cursor: "pointer", outline: "none" }}
                    onPointerEnter={() => setHover(el.id)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => {
                      setHover(el.id);
                      setFocusId(el.id);
                      setRover(el.id);
                    }}
                    onBlur={() => {
                      setHover(null);
                      setFocusId((f) => (f === el.id ? null : f));
                    }}
                    onClick={act}
                    onKeyDown={(e) => onNodeKey(e, el.id)}
                  >
                    {focusId === el.id ? (
                      <rect
                        data-focus-ring
                        x={-4}
                        y={-4}
                        width={NODE_W + 8}
                        height={NODE_H + 8}
                        rx={11}
                        fill="none"
                        stroke="var(--color-focus)"
                        strokeWidth={3}
                      />
                    ) : null}
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={8}
                      fill={on ? "var(--color-accent)" : "var(--color-surface)"}
                      stroke={on ? "var(--color-accent)" : "var(--color-border)"}
                      strokeWidth={on ? 2 : 1}
                    />
                    <text
                      x={12}
                      y={20}
                      fontSize={13}
                      fontWeight={600}
                      fill={on ? "var(--color-accent-contrast)" : "var(--color-text)"}
                    >
                      {on ? "✓ " : ""}
                      {label}
                    </text>
                    <text
                      x={12}
                      y={37}
                      fontSize={11}
                      fill={on ? "var(--color-accent-contrast)" : "var(--color-text-muted)"}
                    >
                      {el.type}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          {status.simulatedLine} {status.freshnessLine}. Config values are read-only.
        </p>
      </Card>
      <Sheet
        title={selectedEl?.name ?? "Element"}
        description={selectedEl ? selectedEl.id : undefined}
        open={panelOpen}
        onOpenChange={setPanelOpen}
      >
        {selectedEl ? (
          <ElementPanel
            el={selectedEl}
            edges={model.edges}
            names={names}
            status={status}
            onEdge={setHoverEdge}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
