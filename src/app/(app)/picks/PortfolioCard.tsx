// D-913 "Follow the picks" card on the Picks page: the practice portfolio of trading exactly the picks.
import type { PortfolioView } from "@/lib/ui/loaders/pickPortfolio";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDay, formatPpm } from "@/lib/view/format";
import { PORTFOLIO_PROFILE_NOTE, profileLabel } from "./text";

const pctText = (ppm: number | null) =>
  ppm === null ? null : formatPpm(ppm, { digits: 1, sign: "always" });

export function PortfolioCard({ v, current }: { v: PortfolioView; current?: string }) {
  const followed = v.profile;
  return (
    <section
      aria-labelledby="portfolio-h"
      className="min-w-0 rounded-lg border border-border bg-surface p-4 text-sm"
      data-testid="pick-portfolio"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="portfolio-h" className="m-0 text-lg font-semibold">
          Follow the picks ({profileLabel(followed)})
        </h2>
        {!v.masked && v.asOfD ? <SimulatedLabel /> : null}
      </div>
      {current !== undefined && current !== followed ? (
        <p className="m-0 mt-1 font-medium" data-testid="portfolio-profile-note">
          {PORTFOLIO_PROFILE_NOTE}
        </p>
      ) : null}
      <p className="m-0 mt-1 text-text-muted">
        Practice money that buys each pick when its buy price is reached, up to {v.slots} stocks at
        once.
      </p>
      <details className="mt-1 text-text-muted">
        <summary className="cursor-pointer font-medium">How it trades</summary>
        <ul className="m-0 mt-1 list-disc pl-5">
          <li>Buys every pick when its buy price is reached, at most {v.slots} stocks at once.</li>
          <li>Sells at the stop-loss or at the aim.</li>
          <li>Sells when the time frame ends with nothing new on the stock.</li>
          <li>Sells early when the stock is weak with no signal.</li>
          <li>Money not invested waits as cash.</li>
        </ul>
      </details>
      {!v.started ? (
        <p className="m-0 mt-2">
          <NotMeasured>Starts with the first pick.</NotMeasured>
        </p>
      ) : (
        <>
          <p className="m-0 mt-2 text-base">
            {v.value ? <Money micro={v.value.micro} currency={v.value.currency} /> : null}{" "}
            {v.sinceStartPpm !== null ? (
              <GainLoss
                value={v.sinceStartPpm}
              >{`${pctText(v.sinceStartPpm)} since the start`}</GainLoss>
            ) : null}
          </p>
          {v.cash && v.seed ? (
            <p className="m-0 mt-1 text-text-muted">
              Started with <Money micro={v.seed.micro} currency={v.seed.currency} />; cash{" "}
              <Money micro={v.cash.micro} currency={v.cash.currency} />
              {v.asOfD ? `, end of day ${formatDay(v.asOfD)}` : ""}.
            </p>
          ) : null}
          <p className="m-0 mt-1 text-text-muted">
            {v.closed === 0
              ? "No trade closed yet."
              : `${v.closed} closed, ${v.wins} with a gain (${Math.round((100 * v.wins) / v.closed)}%).`}
          </p>
          {v.holdings.length > 0 ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0" aria-label="Holdings">
              {v.holdings.map((h, i) => (
                <li key={`${h.stock}-${i}`} className="min-w-0 break-words">
                  <strong>{h.stock}</strong>
                  {h.entry ? (
                    <>
                      {" "}
                      bought at <Money micro={h.entry.micro} currency={h.entry.currency} />
                      {h.entryD ? ` on ${formatDay(h.entryD)}` : ""}
                    </>
                  ) : null}
                  {h.now ? (
                    <>
                      , now <Money micro={h.now.micro} currency={h.now.currency} />
                    </>
                  ) : null}{" "}
                  {h.changePpm !== null ? (
                    <GainLoss value={h.changePpm}>{`(${pctText(h.changePpm)})`}</GainLoss>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-2 text-text-muted">All in cash: waiting for the next good pick.</p>
          )}
        </>
      )}
    </section>
  );
}
