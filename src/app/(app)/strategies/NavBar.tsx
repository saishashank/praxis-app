// NAV bar (UXR-023, UXR-054): a bar from the loss limit (A$300) to the goal (A$1,200) with the start
// (A$600) marked. The fill is in the signed outcome colour (above the start: gain, below: loss, level:
// flat), never grey for a signed value. Every mark is labelled in text. Server component, pure CSS.
import { cn } from "@/components/ui/cn";
import { hueStyle } from "@/components/ui/hue";
import { currencyFormatFor, formatCents } from "@/lib/view/format";

const DEFAULT_MIN = 30_000; // threshold-ok: A$300 loss limit (display default)
const DEFAULT_START = 60_000; // threshold-ok: A$600 start (display default)
const DEFAULT_MAX = 120_000; // threshold-ok: A$1,200 goal (display default)
const PCT = 100; // threshold-ok: percent

export function NavBar({
  label,
  navCents,
  startCents = DEFAULT_START,
  minCents = DEFAULT_MIN,
  maxCents = DEFAULT_MAX,
  currency,
  className,
}: {
  label: string;
  navCents: number | null;
  startCents?: number;
  minCents?: number;
  maxCents?: number;
  /** ISO 4217 code of the amounts (D-1002). */
  currency: string;
  className?: string;
}) {
  const fmt = currencyFormatFor(currency);
  const span = Math.max(1, maxCents - minCents);
  const at = (c: number) => Math.max(0, Math.min(PCT, ((c - minCents) / span) * PCT));
  const known = navCents !== null && Number.isFinite(navCents);
  const hue =
    !known || navCents === startCents
      ? "outcome-flat"
      : navCents > startCents
        ? "positive"
        : "negative";
  const summary = known
    ? `${label}: ${formatCents(navCents, fmt)} on a bar from the loss limit ${formatCents(minCents, fmt)} to the goal ${formatCents(maxCents, fmt)}; start ${formatCents(startCents, fmt)}.`
    : `${label}: not measured yet; bar from the loss limit ${formatCents(minCents, fmt)} to the goal ${formatCents(maxCents, fmt)}; start ${formatCents(startCents, fmt)}.`;
  return (
    <figure data-nav-bar="" className={cn("m-0 min-w-0", className)}>
      <div
        role="img"
        aria-label={summary}
        style={hueStyle(hue)}
        className="relative h-3 w-full rounded bg-surface-2"
      >
        {known ? (
          <div
            data-nav-fill=""
            data-hue={hue}
            className="absolute inset-y-0 left-0 rounded bg-[var(--h-fill)]"
            style={{ width: `${at(navCents)}%` }}
          />
        ) : null}
        <div
          data-nav-start=""
          className="absolute -top-1 -bottom-1 w-0.5 bg-text"
          style={{ left: `${at(startCents)}%` }}
        />
      </div>
      <figcaption className="mt-1 flex min-w-0 flex-wrap justify-between gap-x-2 text-xs text-text-muted">
        <span>Loss limit {formatCents(minCents, fmt)}</span>
        <span data-nav-start-label="">Start {formatCents(startCents, fmt)}</span>
        <span>Goal {formatCents(maxCents, fmt)}</span>
      </figcaption>
    </figure>
  );
}
