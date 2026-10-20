import { ChartTable } from "./ChartTable";
import { clamp, n, tone } from "./format";

export type CifPoint = { month: number; p: number; lo?: number; hi?: number };
export type CifSeries = { name: "Target" | "Bust" | "Stalled"; points: CifPoint[] };

const pct = (p: number) => `${n(p * 100)}%`;
const SERIES_TONE = { Target: tone.c4, Bust: tone.c3, Stalled: tone.c2 } as const;
const SERIES_DASH = { Target: undefined, Bust: "6 3", Stalled: "2 3" } as const;

/** Cumulative-incidence curves with 90 % bands. Series differ by dash pattern as well as colour. */
export function CifCurve({
  series,
  months = 12,
  label = "Chance of each outcome over time",
}: {
  series: CifSeries[];
  months?: number;
  label?: string;
}) {
  const W = 320;
  const H = 140;
  const L = 34;
  const B = 20;
  const x = (m: number) => L + (clamp(m, 0, months) / months) * (W - L - 8);
  const y = (p: number) => 8 + (1 - clamp(p, 0, 1)) * (H - B - 8);
  const summary = `${label}: ${series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return last ? `${s.name} ${pct(last.p)} by month ${last.month}` : `${s.name} no data`;
    })
    .join(", ")}`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line
              x1={L}
              x2={W - 8}
              y1={n(y(g))}
              y2={n(y(g))}
              stroke={tone.grid}
              strokeOpacity={0.5}
            />
            <text x={L - 4} y={n(y(g) + 3)} fontSize={9} textAnchor="end" fill={tone.muted}>
              {pct(g)}
            </text>
          </g>
        ))}
        {[0, 3, 6, 9, 12]
          .filter((m) => m <= months)
          .map((m) => (
            <text key={m} x={n(x(m))} y={H - 6} fontSize={9} textAnchor="middle" fill={tone.muted}>
              {m}m
            </text>
          ))}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.month - b.month);
          if (pts.length === 0) return null;
          const line = pts.map((p, i) => `${i ? "L" : "M"}${n(x(p.month))} ${n(y(p.p))}`).join("");
          const banded = pts.filter((p) => p.lo !== undefined && p.hi !== undefined);
          const band =
            banded.length > 1
              ? banded.map((p, i) => `${i ? "L" : "M"}${n(x(p.month))} ${n(y(p.hi!))}`).join("") +
                [...banded]
                  .reverse()
                  .map((p) => `L${n(x(p.month))} ${n(y(p.lo!))}`)
                  .join("") +
                "Z"
              : null;
          return (
            <g key={s.name}>
              {band && (
                <path d={band} fill={SERIES_TONE[s.name]} fillOpacity={0.15} stroke="none" />
              )}
              <path
                d={line}
                fill="none"
                stroke={SERIES_TONE[s.name]}
                strokeWidth={2}
                strokeDasharray={SERIES_DASH[s.name]}
              />
            </g>
          );
        })}
      </svg>
      <ChartTable
        caption={label}
        headers={["Outcome", "Month", "Chance", "90% interval"]}
        rows={series.flatMap((s) =>
          s.points.map((p) => [
            s.name,
            p.month,
            pct(p.p),
            p.lo !== undefined && p.hi !== undefined
              ? `${pct(p.lo)} to ${pct(p.hi)}`
              : "not measured",
          ]),
        )}
      />
    </figure>
  );
}

export type CifRow = { month: number; target: CifPoint; bust: CifPoint; stalled: CifPoint };

/** Visible table of target / bust / stalled probabilities at 3 / 6 / 12 months, with 90 % intervals. */
export function CifTable({ rows }: { rows: CifRow[] }) {
  const cell = (c: CifPoint) =>
    c.lo !== undefined && c.hi !== undefined
      ? `${pct(c.p)} (${pct(c.lo)} to ${pct(c.hi)})`
      : `${pct(c.p)} (not measured)`;
  return (
    <ChartTable
      visible
      caption="Chance of each outcome, with 90% intervals"
      headers={["Horizon", "Target", "Bust", "Stalled"]}
      rows={rows.map((r) => [`${r.month} months`, cell(r.target), cell(r.bust), cell(r.stalled)])}
    />
  );
}
