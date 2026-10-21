// The model-success strip (UXN-041): one slim line with n, the Wilson interval, still-open picks and the
// luck check, linking to the track record. Until `pick_success_min_n` picks are closed it says "not
// measured yet" and shows no percentage. Read-only: it shows the stored figures of the loader.
import Link from "next/link";
import type { PicksModel } from "@/lib/ui/loaders/picks";
import { Term } from "@/components/ui/Overlays";
import { honestyLine, PRICE_ONLY_LABEL, profileLabel, SELECTION_LINE } from "./text";

export type StripModel = NonNullable<PicksModel["success"]>;

function RangeBar({ lower, upper, pct }: { lower: number; upper: number; pct: number }) {
  return (
    <div
      role="img"
      aria-label={`${pct}% made money; range ${lower} to ${upper} percent`}
      className="relative mt-2 h-2 w-full rounded-full bg-surface-2"
    >
      <span
        className="absolute top-0 h-2 rounded-full bg-accent opacity-40"
        style={{ left: `${lower}%`, width: `${upper - lower}%` }}
      />
      <span className="absolute top-0 h-2 w-1 bg-accent" style={{ left: `${pct}%` }} />
    </div>
  );
}

export function SuccessStrip({
  success,
  profile,
  linkToRecord = true,
}: {
  success: StripModel;
  profile: string;
  linkToRecord?: boolean;
}) {
  const href = `/picks/track-record?profile=${encodeURIComponent(profile)}`;
  const body = (
    <span data-testid="success-line" className="font-semibold break-words">
      {success.line}
    </span>
  );
  return (
    <section
      aria-label={`Model success, ${profileLabel(profile)}`}
      className="min-w-0 rounded-lg border border-border bg-surface p-3 text-sm"
    >
      {linkToRecord ? (
        <Link href={href} className="text-accent underline">
          {body}
        </Link>
      ) : (
        body
      )}
      {success.measured &&
      success.lowerPct !== null &&
      success.upperPct !== null &&
      success.winPct !== null ? (
        <RangeBar lower={success.lowerPct} upper={success.upperPct} pct={success.winPct} />
      ) : null}
      <p className="m-0 mt-2 text-text-muted">
        {success.missed > 0
          ? `${success.missed} missed (price ran away) — not counted as a win or a loss. `
          : ""}
        {SELECTION_LINE} {PRICE_ONLY_LABEL}
      </p>
      <p className="m-0 mt-1 text-text-muted">
        {success.insidePct !== null
          ? `${success.insidePct}% of closed results landed inside their published range. `
          : ""}
        {success.beatsLuck ? null : (
          <Term
            meaning="Model: not proven yet. The live record has not beaten the luck check, a random company with the same stop, aim and time frame, in a significance test."
            official="UNVALIDATED"
          >
            Model: not proven yet
          </Term>
        )}
      </p>
      <p className="m-0 mt-1 text-xs text-text-muted">{honestyLine(success.beatsLuck)}</p>
    </section>
  );
}
