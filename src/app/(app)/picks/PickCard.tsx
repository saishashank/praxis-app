// One pick card (UXN-040, UXN-045): plain words, every price from the stored pick. A masked user sees
// "Stock A", percentages and counts only: no company name, price, size or exact date (DAT-124, UX-009).
import Link from "next/link";
import type { PickRowView } from "@/lib/ui/loaders/picks";
import { formatDate } from "@/lib/view/format";
import { Rail } from "@/components/ui/Family";
import { buttonClass } from "@/components/ui/Button";
import { PickFamily } from "./FamilyInfo";
import { Term } from "@/components/ui/Overlays";
import { ValidationBadge } from "@/components/ui/Badges";
import { Masked, Money, SimulatedLabel } from "@/components/ui/Values";
import { FAMILY_BADGES, honestyLine, pct, STOP_GAP_HOVER, stateText, timeFrameText } from "./text";

function StateBadge({ pick }: { pick: PickRowView }) {
  const o = pick.outcome;
  let text = stateText(o);
  if (o?.state === "bought" && o.entry) text = "Bought";
  if (o?.state === "closed" && o.netPpm !== null) text = `Closed ${pct(o.netPpm)}`;
  return (
    <span
      data-testid="state-badge"
      className="inline-flex rounded-md bg-surface-2 px-2 py-1 text-xs font-semibold"
    >
      {text}
      {o?.state === "bought" && o.entry ? (
        <>
          {" at "}
          <Money micro={o.entry.micro} />
        </>
      ) : null}
    </span>
  );
}

export function PickCard({
  pick,
  masked,
  beatsLuck,
}: {
  pick: PickRowView;
  masked: boolean;
  beatsLuck: boolean;
}) {
  const frame = timeFrameText(pick.timeFrameSessions);
  const hue = FAMILY_BADGES[pick.family]?.code;
  const primaryHref = pick.cardHref ?? `/picks/${encodeURIComponent(pick.id)}`;
  return (
    <article
      data-testid="pick-card"
      aria-label={`Pick ${pick.rank}: ${pick.stock}`}
      className="ui-motion block min-w-0 break-words motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-safe:hover:shadow-md [[data-motion=off]_&]:hover:translate-y-0 [[data-motion=off]_&]:hover:shadow-none"
    >
      <Rail
        hue={hue ? `family-${hue}` : "outcome-flat"}
        header={
          <header className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <PickFamily pick={pick} />
              <h2 className="m-0 text-lg font-semibold">
                {pick.stock}
                {pick.company ? (
                  <span className="font-normal text-text-muted"> · {pick.company}</span>
                ) : null}
              </h2>
              <p className="m-0 text-sm text-text-muted">{pick.familyName}</p>
            </div>
            <StateBadge pick={pick} />
          </header>
        }
      >
        <ul className="m-0 mt-3 list-none space-y-1 p-0 text-sm">
          <li>
            <Term meaning="The highest price at which this pick counts as bought: tonight's closing price plus a small allowance for price slip.">
              Buy up to
            </Term>{" "}
            {masked || !pick.buyUpTo ? <Masked /> : <Money micro={pick.buyUpTo.micro} />} (from{" "}
            {masked ? pick.validUntil : formatDate(pick.validUntil)}, checked again each night)
          </li>
          <li>
            <Term meaning={STOP_GAP_HOVER}>Stop-loss</Term>{" "}
            {masked || !pick.stop ? <Masked /> : <Money micro={pick.stop.micro} />}
            {pick.stopPpm !== null ? ` (${pct(pick.stopPpm)})` : null}
          </li>
          <li>
            <Term meaning="The price at which the strategy takes profit, from its own rule, and the share of past similar trades that reached it.">
              Aim
            </Term>{" "}
            {masked || !pick.aim ? <Masked /> : <Money micro={pick.aim.micro} />}
            {pick.aimPpm !== null ? ` (${pct(pick.aimPpm)})` : null}
            {frame ? ` in ${frame}` : null}
          </li>
          <li>
            Past similar trades:{" "}
            {pick.scenario ? (
              <>
                bad case {pct(pick.scenario.badPpm)}, typical {pct(pick.scenario.typicalPpm)}, good
                case {pct(pick.scenario.goodPpm)} ({pick.scenario.n} trades)
              </>
            ) : (
              <span className="italic text-text-muted">not enough similar cases yet</span>
            )}
          </li>
          <li>
            Suggested size:{" "}
            {masked || !pick.size || !pick.riskAtStop ? (
              <Masked />
            ) : (
              <>
                up to <Money micro={pick.size.micro} />; if the stop-loss is hit you would lose
                about <Money micro={pick.riskAtStop.micro} /> plus fees
              </>
            )}
          </li>
          <li>
            <ValidationBadge label={pick.label} />
          </li>
          {pick.basedOn[0] ? <li>Based on: {pick.basedOn[0]}</li> : null}
        </ul>

        <p className="m-0 mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="inline-flex flex-wrap items-center gap-3">
            <Link href={primaryHref} className={buttonClass("default", "no-underline")}>
              Why this pick
            </Link>
            {pick.cardHref ? (
              <Link
                href={`/picks/${encodeURIComponent(pick.id)}`}
                className="text-accent underline"
              >
                Pick details
              </Link>
            ) : null}
          </span>
          {masked ? null : <SimulatedLabel />}
        </p>
        <p data-testid="honesty-line" className="m-0 mt-2 text-xs text-text-muted">
          {honestyLine(beatsLuck)}
        </p>
      </Rail>
    </article>
  );
}
