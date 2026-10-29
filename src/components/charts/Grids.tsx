import type { CSSProperties } from "react";
import { ChartTable } from "./ChartTable";
import { clamp, n, signed, tone } from "./format";

export type HeatCell = { label: string; value: number | null };

/** Sector day-change grid (UXN-270): fill strength by size, hue by sign (chart-1 up / chart-3 down), text always shows sign + arrow. */
export function HeatGrid({
  cells,
  label,
  columns = 4,
  maxAbs = 3,
}: {
  cells: HeatCell[];
  label: string;
  columns?: number;
  maxAbs?: number;
}) {
  const cw = 80;
  const ch = 40;
  const rows = Math.ceil(cells.length / columns) || 1;
  const summary = `${label}: ${cells.map((c) => `${c.label} ${c.value === null ? "no data" : signed(c.value)}`).join(", ")}`;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${columns * cw} ${rows * ch}`}
        width="100%"
        height={rows * ch}
      >
        {cells.map((c, i) => {
          const x = (i % columns) * cw;
          const y = Math.floor(i / columns) * ch;
          const strength = c.value === null ? 0 : clamp(Math.abs(c.value) / maxAbs, 0, 1);
          return (
            <g key={c.label}>
              <rect
                x={x + 1}
                y={y + 1}
                width={cw - 2}
                height={ch - 2}
                fill={c.value !== null && c.value < 0 ? tone.c3 : tone.c1}
                fillOpacity={n(0.12 + 0.4 * strength)}
                stroke={tone.grid}
                strokeDasharray={c.value === null ? "3 3" : undefined}
              />
              <text x={x + cw / 2} y={y + 17} fontSize={10} textAnchor="middle" fill={tone.text}>
                {c.label.length > 12 ? `${c.label.slice(0, 11)}…` : c.label}
              </text>
              <text
                x={x + cw / 2}
                y={y + 31}
                fontSize={10}
                textAnchor="middle"
                fill={tone.text}
                fontFamily="var(--font-mono)"
              >
                {c.value === null ? "–" : signed(c.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartTable
        caption={label}
        headers={["Sector", "Day change"]}
        rows={cells.map((c) => [c.label, c.value === null ? "no data" : signed(c.value)])}
      />
    </figure>
  );
}

export type CalendarDay = { date: string; value: number | null };

/** Per-currency profit/loss calendar (UXN-206): one currency per grid, never summed across currencies. */
export function CalendarGrid({
  days,
  currency,
  label,
}: {
  days: CalendarDay[];
  currency: string;
  label: string;
}) {
  const cell = 36;
  const rows = Math.ceil(days.length / 7) || 1;
  const maxAbs = Math.max(1e-9, ...days.map((d) => Math.abs(d.value ?? 0)));
  const fmt = (v: number) =>
    `${v > 0 ? "▲ +" : v < 0 ? "▼ −" : "● "}${currency}${Math.abs(v).toFixed(2)}`;
  const summary = `${label} (${currency}): ${days.length} days, ${days.filter((d) => d.value !== null).length} with results`;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${7 * cell} ${rows * cell}`}
        width="100%"
        height={rows * cell}
      >
        {days.map((d, i) => {
          const x = (i % 7) * cell;
          const y = Math.floor(i / 7) * cell;
          const v = d.value;
          return (
            <g key={d.date}>
              <rect
                x={x + 1}
                y={y + 1}
                width={cell - 2}
                height={cell - 2}
                fill={v !== null && v < 0 ? tone.c3 : tone.c1}
                fillOpacity={n(v === null ? 0 : 0.12 + 0.4 * (Math.abs(v) / maxAbs))}
                stroke={tone.grid}
                strokeDasharray={v === null ? "3 3" : undefined}
              />
              <text x={x + 4} y={y + 12} fontSize={9} fill={tone.muted}>
                {d.date.slice(8)}
              </text>
              <text x={x + cell / 2} y={y + 27} fontSize={9} textAnchor="middle" fill={tone.text}>
                {v === null ? "–" : v > 0 ? "▲" : v < 0 ? "▼" : "●"}
              </text>
            </g>
          );
        })}
      </svg>
      <ChartTable
        caption={`${label} (${currency})`}
        headers={["Date", "Profit / loss"]}
        rows={days.map((d) => [d.date, d.value === null ? "no result" : fmt(d.value)])}
      />
    </figure>
  );
}

export type SectorHeatCell = { label: string; value: number | null; hue: string | null };

/** Tint strength (percent of the sector fill over the surface): 10 % at no move up to 30 % at the cap. */
const HEAT_MIN = 10; // threshold-ok: weakest tint, percent
const HEAT_SPAN = 20; // threshold-ok: extra tint at the full move, percent

/**
 * Sector heat grid (UXR-051, UXR-022): each tile takes its sector hue, and the tint grows with the size
 * of the day's move. The arrow, sign and number are body text on the tint (never white-on-fill), so the
 * text stays AA; the tint is capped well below the full fill. A tile without a hue uses the neutral fill.
 */
export function SectorHeatGrid({
  cells,
  label,
  maxAbs = 3,
}: {
  cells: SectorHeatCell[];
  label: string;
  maxAbs?: number;
}) {
  return (
    <figure className="m-0">
      <ul
        aria-label={label}
        className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 lg:grid-cols-4"
      >
        {cells.map((c) => {
          const strength = c.value === null ? 0 : clamp(Math.abs(c.value) / maxAbs, 0, 1);
          const pct = n(HEAT_MIN + HEAT_SPAN * strength);
          const hue = c.hue ?? "outcome-flat";
          const style = {
            "--h-fill": `var(--color-${hue}-fill)`,
            background: `color-mix(in srgb, var(--h-fill) ${pct}%, var(--color-surface))`,
            borderLeftColor: "var(--h-fill)",
          } as CSSProperties;
          return (
            <li
              key={c.label}
              data-sector-hue={c.hue ?? "none"}
              style={style}
              className="min-w-0 rounded-lg border border-l-4 border-border p-2 text-text"
            >
              <span className="block text-xs break-words">{c.label}</span>
              <span className="block text-sm font-semibold tabular-nums">
                {c.value === null ? "—" : signed(c.value)}
              </span>
            </li>
          );
        })}
      </ul>
      <ChartTable
        caption={label}
        headers={["Sector", "Day change"]}
        rows={cells.map((c) => [c.label, c.value === null ? "no data" : signed(c.value)])}
      />
    </figure>
  );
}
