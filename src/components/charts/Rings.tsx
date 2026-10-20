import { ChartTable } from "./ChartTable";
import { clamp, n, tone } from "./format";

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M${n(x1)} ${n(y1)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${n(x2)} ${n(y2)}`;
}

/** Radial gauge, 270° sweep, with tick marks at 70 / 90 / 95 (UXN-285 d). */
export function Gauge({
  value,
  label,
  marks = [70, 90, 95],
}: {
  value: number;
  label: string;
  marks?: number[];
}) {
  const v = clamp(value, 0, 100);
  const start = -135;
  const at = (p: number) => start + (p / 100) * 270;
  const summary = `${label}: ${n(v)} of 100. Marks at ${marks.join(", ")}`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox="0 0 120 110" width={120} height={110}>
        <path d={arc(60, 60, 44, start, 135)} fill="none" stroke={tone.grid} strokeWidth={8} />
        {v > 0 && (
          <path d={arc(60, 60, 44, start, at(v))} fill="none" stroke={tone.c1} strokeWidth={8} />
        )}
        {marks.map((m) => {
          const [x1, y1] = polar(60, 60, 38, at(m));
          const [x2, y2] = polar(60, 60, 52, at(m));
          return (
            <line
              key={m}
              x1={n(x1)}
              y1={n(y1)}
              x2={n(x2)}
              y2={n(y2)}
              stroke={tone.text}
              strokeWidth={2}
            />
          );
        })}
        <text
          x={60}
          y={64}
          fontSize={20}
          textAnchor="middle"
          fill={tone.text}
          fontFamily="var(--font-mono)"
        >
          {n(v)}
        </text>
        <text x={60} y={104} fontSize={10} textAnchor="middle" fill={tone.muted}>
          {label}
        </text>
      </svg>
      <ChartTable
        caption={label}
        headers={["Measure", "Value"]}
        rows={[
          ["Value", n(v)],
          ...marks.map((m) => [`Mark ${m}`, v >= m ? "reached" : "not reached"]),
        ]}
      />
    </figure>
  );
}

export type RingSegment = { id: string; label: string; healthy: boolean; href?: string };

/** Nine-segment status ring (UXN-283). Unhealthy segments are dashed as well as recoloured. */
export function StatusRing({ segments }: { segments: RingSegment[] }) {
  const total = segments.length;
  const ok = segments.filter((s) => s.healthy).length;
  const gap = 4;
  const sweep = 360 / Math.max(1, total);
  const summary = `${ok} / ${total} healthy: ${segments.map((s) => `${s.label} ${s.healthy ? "healthy" : "needs attention"}`).join(", ")}`;
  return (
    <figure className="m-0">
      <svg role="img" aria-label={summary} viewBox="0 0 120 120" width={120} height={120}>
        {segments.map((s, i) => {
          const path = (
            <path
              d={arc(60, 60, 46, i * sweep + gap / 2, (i + 1) * sweep - gap / 2)}
              fill="none"
              stroke={s.healthy ? tone.c4 : tone.c3}
              strokeWidth={10}
              strokeDasharray={s.healthy ? undefined : "4 3"}
            >
              <title>{`${s.label}: ${s.healthy ? "healthy" : "needs attention"}`}</title>
            </path>
          );
          return s.href ? (
            <a
              key={s.id}
              href={s.href}
              aria-label={`${s.label}: ${s.healthy ? "healthy" : "needs attention"}`}
            >
              {path}
            </a>
          ) : (
            <g key={s.id}>{path}</g>
          );
        })}
        <text
          x={60}
          y={62}
          fontSize={16}
          textAnchor="middle"
          fill={tone.text}
          fontFamily="var(--font-mono)"
        >
          {ok} / {total}
        </text>
        <text x={60} y={76} fontSize={9} textAnchor="middle" fill={tone.muted}>
          healthy
        </text>
      </svg>
      <ChartTable
        caption="System status"
        headers={["Part", "Status"]}
        rows={segments.map((s) => [s.label, s.healthy ? "healthy" : "needs attention"])}
      />
    </figure>
  );
}
