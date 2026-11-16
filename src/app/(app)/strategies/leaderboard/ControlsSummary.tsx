// A short factual card above the "Matched controls" table (UXN-062, D-1201): the best strategy's average
// change per finished round next to the range of the matched controls. Computed from the rows the page
// already loads, in descriptive words; it ranks nothing (UX-020: the order and the tied groups stay as shown).
import type { LeaderRow } from "@/lib/ui/loaders/strategies";
import { formatPpm } from "@/lib/view/format";

const has = (r: LeaderRow): r is LeaderRow & { meanReturnPpm: number } =>
  r.finished > 0 && r.meanReturnPpm !== null && Number.isFinite(r.meanReturnPpm);

const signed = (ppm: number): string => formatPpm(ppm, { sign: "always" });

export function ControlsSummary({
  strategies,
  controls,
}: {
  strategies: LeaderRow[];
  controls: LeaderRow[];
}) {
  const scored = strategies.filter(has);
  if (scored.length === 0) return null;
  const best = scored.reduce((a, b) =>
    b.meanReturnPpm > a.meanReturnPpm || (b.meanReturnPpm === a.meanReturnPpm && b.name < a.name)
      ? b
      : a,
  );
  const ctl = controls.filter(has).map((c) => c.meanReturnPpm);
  const lo = Math.min(...ctl);
  const hi = Math.max(...ctl);
  const range =
    ctl.length === 0
      ? "not measured yet"
      : lo === hi
        ? signed(lo)
        : `${signed(lo)} to ${signed(hi)}`;
  return (
    <p
      data-testid="controls-summary"
      className="m-0 rounded-lg border border-border bg-surface p-3 text-sm"
    >
      <strong>Best strategy:</strong> {best.name},{" "}
      <span className="font-mono">{signed(best.meanReturnPpm)}</span> per finished round; matched
      controls: <span className="font-mono">{range}</span>
    </p>
  );
}
