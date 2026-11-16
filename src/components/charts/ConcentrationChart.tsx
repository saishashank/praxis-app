// Concentration chart (UXN-154, D-1201): how much of all value each share holds, drawn by hand in SVG
// (D-128, no chart package). A donut for 12 items or fewer, a treemap for more. The labels arrive from the
// page already masked ("Stock A") where the viewer is masked (DAT-124), so this component never sees a code
// it must hide. Like the other charts it carries an aria-label summary and a screen-reader table (UXN-001);
// colour is never the only cue: every slice is numbered and listed with its share in words.
import { formatPpm } from "@/lib/view/format";
import { ChartTable } from "./ChartTable";
import { n, tone } from "./format";

export type ConcentrationItem = { label: string; weightPpm: number; strategies: number };

/** A donut up to this many items, a treemap above it (UXN-154). */
export const DONUT_MAX = 12; // threshold-ok: items

const WHOLE_PPM = 1_000_000; // threshold-ok: ppm in 100%
const REST_LABEL = "Everything else";
const FILLS = [tone.c1, tone.c2, tone.c3, tone.c4] as const;

type Slice = { label: string; ppm: number; rest: boolean };

function slicesOf(items: ConcentrationItem[]): Slice[] {
  const real = items
    .filter((i) => Number.isFinite(i.weightPpm) && i.weightPpm > 0)
    .map((i) => ({ label: i.label, ppm: i.weightPpm, rest: false }));
  const sum = real.reduce((a, s) => a + s.ppm, 0);
  return sum < WHOLE_PPM
    ? [...real, { label: REST_LABEL, ppm: WHOLE_PPM - sum, rest: true }]
    : real;
}

const fillOf = (s: Slice, i: number): string => (s.rest ? tone.grid : FILLS[i % FILLS.length]!);

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function ringPath(
  cx: number,
  cy: number,
  ro: number,
  ri: number,
  from: number,
  to: number,
): string {
  const large = to - from > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, ro, from);
  const [x2, y2] = polar(cx, cy, ro, to);
  const [x3, y3] = polar(cx, cy, ri, to);
  const [x4, y4] = polar(cx, cy, ri, from);
  return `M${n(x1)} ${n(y1)}A${ro} ${ro} 0 ${large} 1 ${n(x2)} ${n(y2)}L${n(x3)} ${n(y3)}A${ri} ${ri} 0 ${large} 0 ${n(x4)} ${n(y4)}Z`;
}

type Rect = { x: number; y: number; w: number; h: number };
type Placed = Rect & { s: Slice; i: number };

/** Balanced binary split: each cut puts about half of the weight on each side, along the longer edge. */
function tree(slices: { s: Slice; i: number }[], r: Rect, out: Placed[]): void {
  if (slices.length === 0) return;
  if (slices.length === 1) {
    out.push({ ...r, ...slices[0]! });
    return;
  }
  const total = slices.reduce((a, x) => a + x.s.ppm, 0);
  let cut = 1;
  let acc = slices[0]!.s.ppm;
  while (cut < slices.length - 1 && acc + slices[cut]!.s.ppm / 2 <= total / 2) {
    acc += slices[cut]!.s.ppm;
    cut += 1;
  }
  const share = acc / total;
  const a = slices.slice(0, cut);
  const b = slices.slice(cut);
  if (r.w >= r.h) {
    tree(a, { x: r.x, y: r.y, w: r.w * share, h: r.h }, out);
    tree(b, { x: r.x + r.w * share, y: r.y, w: r.w * (1 - share), h: r.h }, out);
  } else {
    tree(a, { x: r.x, y: r.y, w: r.w, h: r.h * share }, out);
    tree(b, { x: r.x, y: r.y + r.h * share, w: r.w, h: r.h * (1 - share) }, out);
  }
}

const SIZE = 200;
const TREE_W = 320;
const TREE_H = 180;

export function ConcentrationChart({ items }: { items: ConcentrationItem[] }) {
  const slices = slicesOf(items);
  if (slices.every((s) => s.rest)) return null; // nothing held
  const kind = items.length <= DONUT_MAX ? "donut" : "treemap";
  const shown = slices.map((s) => `${s.label} ${formatPpm(s.ppm)}`).join(", ");
  const summary = `${kind === "donut" ? "Donut" : "Treemap"} chart of how much of all value each stock holds: ${shown}`;
  const held = new Map(items.map((i) => [i.label, i.strategies] as const));
  const total = slices.reduce((a, s) => a + s.ppm, 0);

  let body;
  if (kind === "donut") {
    const starts = slices.map((_, i) =>
      slices.slice(0, i).reduce((a, x) => a + (x.ppm / total) * 360, 0),
    );
    body = (
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        width={SIZE}
        height={SIZE}
        className="max-w-full"
      >
        {slices.map((s, i) => {
          const sweep = (s.ppm / total) * 360;
          const start = starts[i]!;
          const [tx, ty] = polar(SIZE / 2, SIZE / 2, 76, start + sweep / 2);
          return (
            <g key={`${s.label}-${i}`} data-slice={i + 1}>
              {sweep >= 359.99 ? (
                <circle
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={76}
                  fill="none"
                  stroke={fillOf(s, i)}
                  strokeWidth={48}
                />
              ) : (
                <path
                  d={ringPath(SIZE / 2, SIZE / 2, 100, 52, start, start + sweep)}
                  fill={fillOf(s, i)}
                  stroke={tone.surface}
                  strokeWidth={2}
                />
              )}
              {sweep >= 24 && !s.rest ? (
                <text
                  x={n(tx)}
                  y={n(ty + 4)}
                  fontSize={12}
                  textAnchor="middle"
                  fill={tone.surface}
                  fontFamily="var(--font-mono)"
                >
                  {i + 1}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    );
  } else {
    const placed: Placed[] = [];
    tree(
      slices.map((s, i) => ({ s, i })),
      { x: 0, y: 0, w: TREE_W, h: TREE_H },
      placed,
    );
    body = (
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${TREE_W} ${TREE_H}`}
        width="100%"
        height={TREE_H}
        preserveAspectRatio="xMidYMid meet"
      >
        {placed.map((p) => (
          <g key={`${p.s.label}-${p.i}`} data-slice={p.i + 1}>
            <rect
              x={n(p.x)}
              y={n(p.y)}
              width={n(p.w)}
              height={n(p.h)}
              fill={fillOf(p.s, p.i)}
              stroke={tone.surface}
              strokeWidth={2}
            />
            {p.w >= 22 && p.h >= 16 && !p.s.rest ? (
              <text
                x={n(p.x + 5)}
                y={n(p.y + 14)}
                fontSize={11}
                fill={tone.surface}
                fontFamily="var(--font-mono)"
              >
                {p.i + 1}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    );
  }

  return (
    <figure data-chart={kind} className="m-0 flex min-w-0 flex-wrap items-start gap-4">
      {body}
      <figcaption className="min-w-0">
        <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
          {slices.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex min-w-0 items-center gap-2 break-words">
              <span
                aria-hidden="true"
                className="inline-block size-3 shrink-0 rounded-sm border border-border"
                style={{ background: fillOf(s, i) }}
              />
              <span>
                {s.rest ? "" : `${i + 1}. `}
                {s.label}: <span className="font-mono">{formatPpm(s.ppm)}</span>
              </span>
            </li>
          ))}
        </ol>
      </figcaption>
      <ChartTable
        caption="Share of all value by stock"
        headers={["Stock", "Share of all value", "Strategies holding it"]}
        rows={slices.map((s) => [
          s.label,
          formatPpm(s.ppm),
          s.rest ? "not applicable" : String(held.get(s.label) ?? 0),
        ])}
      />
    </figure>
  );
}
