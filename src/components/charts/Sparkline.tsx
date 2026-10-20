import { ChartTable } from "./ChartTable";
import { n, signed, tone } from "./format";

/** Server-rendered sparkline (UXN-052): non-interactive, nulls break the line, text alternative included. */
export function Sparkline({
  values,
  label,
  width = 120,
  height = 32,
}: {
  values: Array<number | null>;
  label: string;
  width?: number;
  height?: number;
}) {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (real.length < 2) {
    return (
      <span role="img" aria-label={`${label}: not enough data`} className="text-sm">
        –
      </span>
    );
  }
  const lo = Math.min(...real);
  const hi = Math.max(...real);
  const span = hi - lo || 1;
  const pad = 2;
  const step = (width - 2 * pad) / (values.length - 1);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = pad + i * step;
    const y = pad + (height - 2 * pad) * (1 - (v - lo) / span);
    d += `${pen ? "L" : "M"}${n(x)} ${n(y)}`;
    pen = true;
  });
  const first = real[0]!;
  const last = real[real.length - 1]!;
  const change = first === 0 ? 0 : ((last - first) / Math.abs(first)) * 100;
  const summary = `${label}: ${values.length} sessions, ${signed(change)} from ${n(first)} to ${n(last)}, low ${n(lo)}, high ${n(hi)}`;
  return (
    <figure className="inline-block m-0">
      <svg
        role="img"
        aria-label={summary}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <path d={d} fill="none" stroke={tone.c1} strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <ChartTable
        caption={label}
        headers={["Session", "Value"]}
        rows={values.map((v, i) => [i + 1, v === null ? "no data" : n(v)])}
      />
    </figure>
  );
}
