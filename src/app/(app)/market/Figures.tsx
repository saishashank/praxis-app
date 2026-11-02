// Small figure helpers of the Market pages (UXR-007, UXR-008, UXR-022). Figures are set in the sans face
// with tabular numerals (not the mono face); a missing value is "—" with a muted hint, never blank or 0.
// The change is outcome-coloured (positive / negative tokens) and always carries an arrow, a sign and
// words in the accessible name, so colour is never the only cue (UXR-002).
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { formatPpm, gainLossGlyph, gainLossWord } from "@/lib/view/format";

export const FIG = "font-sans tabular-nums";

/** "—" with a muted hint under it. */
export function Dash({ hint = "Not available" }: { hint?: string }) {
  return (
    <span className={cn(FIG, "inline-flex flex-col")}>
      <span aria-hidden="true">—</span>
      <span className="text-xs text-text-muted">{hint}</span>
    </span>
  );
}

/** Day change from parts per million: outcome colour, arrow, sign. */
export function Change({ ppm, className }: { ppm: number | null | undefined; className?: string }) {
  if (ppm === null || ppm === undefined || !Number.isFinite(ppm))
    return <Dash hint="No change yet" />;
  const text = formatPpm(ppm, { sign: "always" });
  const tone = ppm > 0 ? "text-positive" : ppm < 0 ? "text-negative" : "text-text-muted";
  return (
    <span
      role="img"
      aria-label={`${gainLossWord(ppm)}: ${text}`}
      data-outcome={ppm > 0 ? "up" : ppm < 0 ? "down" : "flat"}
      className={cn(FIG, "inline-flex items-baseline gap-1 font-semibold", tone, className)}
    >
      <span aria-hidden="true">{gainLossGlyph(ppm)}</span>
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

/** One key-number tile: label above, value below (UXR-022). */
export function Tile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface p-3">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={cn(FIG, "m-0 mt-1 min-w-0 text-sm font-semibold break-words")}>{children}</dd>
    </div>
  );
}
