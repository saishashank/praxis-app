// Tonight's picks as a table-like list (D-1849): one row per pick with the stock, the strategy, the buy
// zone, the stop-loss, the aim, the time frame and the status. The full PickCard stays one step away: a
// "Details" disclosure under each row, which holds the card with its "Why this pick" link to /picks/[id]. A masked user (Editor /
// Viewer without a grant) sees "Stock A" and a lock mark in place of every price (DAT-124, UX-009). A wide
// table scrolls inside its own container, so the page never scrolls sideways at 360 px.
import type { ReactNode } from "react";
import type { PickRowView } from "@/lib/ui/loaders/picks";
import type { AlertChipView } from "@/lib/ui/loaders/pickAlerts";
import { Masked, Money } from "@/components/ui/Values";
import { PickCard, StateBadge } from "./PickCard";
import { pct, timeFrameText } from "./text";

const TH = "whitespace-nowrap px-3 py-2 text-left text-xs font-semibold text-text-muted";
const TD = "px-3 py-2 align-top";

function Price({
  masked,
  v,
  note,
}: {
  masked: boolean;
  v: PickRowView["stop"];
  note?: string | null;
}) {
  if (masked || !v) return <Masked />;
  return (
    <>
      <Money micro={v.micro} currency={v.currency} />
      {note ? <span className="text-text-muted"> ({note})</span> : null}
    </>
  );
}

export function PickTable({
  picks,
  profile,
  masked,
  beatsLuck,
  chips,
  realD,
  extras,
  labelledBy,
}: {
  picks: readonly PickRowView[];
  profile: string;
  masked: boolean;
  beatsLuck: boolean;
  chips: ReadonlyMap<string, AlertChipView>;
  realD: string | null;
  extras: ReadonlyMap<string, ReactNode> | null;
  labelledBy: string;
}) {
  return (
    <div
      className="min-w-0 max-w-full overflow-x-auto rounded-lg border border-border bg-surface"
      data-testid="pick-table"
    >
      <table className="w-full min-w-[44rem] border-collapse text-sm" aria-labelledby={labelledBy}>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH}>
              Stock
            </th>
            <th scope="col" className={TH}>
              Strategy
            </th>
            <th scope="col" className={TH}>
              Buy up to
            </th>
            <th scope="col" className={TH}>
              Stop-loss
            </th>
            <th scope="col" className={TH}>
              Aim
            </th>
            <th scope="col" className={TH}>
              Time frame
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
          </tr>
        </thead>
        {picks.map((p) => {
          const frame = timeFrameText(p.timeFrameSessions);
          return (
            <tbody key={p.id} className="border-b border-border last:border-b-0">
              <tr data-testid="pick-row">
                <th scope="row" className={`${TD} text-left font-semibold`}>
                  <span className="block min-w-0 break-words">
                    <span className="text-text-muted">#{p.rank} </span>
                    {p.stock}
                    {p.company ? (
                      <span className="font-normal text-text-muted"> · {p.company}</span>
                    ) : null}
                  </span>
                </th>
                <td className={TD}>{p.familyName}</td>
                <td className={TD}>
                  <Price masked={masked} v={p.buyUpTo} />
                </td>
                <td className={TD}>
                  <Price
                    masked={masked}
                    v={p.stop}
                    note={p.stopPpm !== null ? pct(p.stopPpm) : null}
                  />
                </td>
                <td className={TD}>
                  <Price
                    masked={masked}
                    v={p.aim}
                    note={p.aimPpm !== null ? pct(p.aimPpm) : null}
                  />
                </td>
                <td className={TD}>{frame ?? "—"}</td>
                <td className={TD}>
                  <StateBadge pick={p} />
                </td>
              </tr>
              <tr>
                <td colSpan={7} className="px-3 pb-3">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-accent">
                      Details for {p.stock}
                    </summary>
                    <div className="mt-2 min-w-0 max-w-full whitespace-normal">
                      <PickCard
                        pick={p}
                        profile={profile}
                        masked={masked}
                        beatsLuck={beatsLuck}
                        chip={chips.get(`${realD}.${profile}.${p.rank}`) ?? null}
                        extra={extras?.get(p.id) ?? null}
                      />
                    </div>
                  </details>
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
