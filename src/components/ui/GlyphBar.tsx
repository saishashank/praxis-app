// Glyph bar (UX-011): a strategy's value on a bar from zero to the goal, with the loss limit, the
// "stalled" floor and the goal marked and LABELLED IN TEXT (never colour alone). Amounts are integer
// cents. A missing value draws no marker and says "Not measured yet". Pure CSS positioning, no client code.
import { formatCents } from "@/lib/view/format";
import { cn } from "./cn";
import { NotMeasured } from "./Values";

export type GlyphBarProps = {
  valueCents: number | null | undefined;
  seedCents?: number;
  stallCents?: number;
  bustCents?: number;
  targetCents?: number;
  /** Accessible name prefix, e.g. the strategy's name. */
  label: string;
};

const SEED = 60_000; // threshold-ok: A$600 start (display default; real values come from config)
const STALL = 51_100; // threshold-ok: A$511 stall floor
const BUST = 30_000; // threshold-ok: A$300 loss limit
const TARGET = 120_000; // threshold-ok: A$1,200 goal

function pct(v: number, max: number): number {
  return Math.max(0, Math.min(100, (v / max) * 100)); // threshold-ok: percent
}

export function GlyphBar({
  valueCents,
  seedCents = SEED,
  stallCents = STALL,
  bustCents = BUST,
  targetCents = TARGET,
  label,
}: GlyphBarProps) {
  const known = typeof valueCents === "number" && Number.isFinite(valueCents);
  const max = Math.max(targetCents, known ? valueCents : 0, 1);
  const marks = [
    { key: "bust", text: `Loss limit ${formatCents(bustCents)}`, at: bustCents },
    { key: "stall", text: `Stalled below ${formatCents(stallCents)}`, at: stallCents },
    { key: "seed", text: `Start ${formatCents(seedCents)}`, at: seedCents },
    { key: "target", text: `Goal ${formatCents(targetCents)}`, at: targetCents },
  ];
  const summary = known
    ? `${label}: ${formatCents(valueCents)}. ${marks.map((m) => m.text).join(", ")}.`
    : `${label}: not measured yet. ${marks.map((m) => m.text).join(", ")}.`;
  return (
    <figure className="m-0 min-w-0">
      <div role="img" aria-label={summary} className="relative h-3 w-full rounded bg-surface-2">
        {known ? (
          <div
            data-glyph-fill=""
            className={cn("absolute inset-y-0 left-0 rounded bg-chart-1")}
            style={{ width: `${pct(valueCents, max)}%` }}
          />
        ) : null}
        {marks.map((m) => (
          <span
            key={m.key}
            data-glyph-mark={m.key}
            aria-hidden="true"
            className="absolute -top-1 h-5 w-0.5 bg-text"
            style={{ left: `${pct(m.at, max)}%` }}
          />
        ))}
      </div>
      <figcaption className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
        <span className="font-mono text-text">
          {known ? formatCents(valueCents) : <NotMeasured />}
        </span>
        {marks.map((m) => (
          <span key={m.key} className="break-words">
            {m.text}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
