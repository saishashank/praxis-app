// D-913 "Follow the picks" card on the Picks page: the practice portfolio of trading exactly the picks.
import type { PortfolioView } from "@/lib/ui/loaders/pickPortfolio";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDate, formatPpm } from "@/lib/view/format";

const pctText = (ppm: number | null) =>
  ppm === null ? null : formatPpm(ppm, { digits: 1, sign: "always" });

export function PortfolioCard({ v }: { v: PortfolioView }) {
  return (
    <section
      aria-labelledby="portfolio-h"
      className="min-w-0 rounded-lg border border-border bg-surface p-4 text-sm"
      data-testid="pick-portfolio"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="portfolio-h" className="m-0 text-lg font-semibold">
          Follow the picks
        </h2>
        {!v.masked && v.asOfD ? <SimulatedLabel /> : null}
      </div>
      <p className="m-0 mt-1 text-text-muted">
        Practice money that buys every pick when its buy price is reached, at most {v.slots} stocks
        at once, and sells at the stop-loss, at the aim, when the time frame ends with nothing new
        on the stock, or early when it is weak with no signal. Money not invested waits as cash.
      </p>
      {!v.started ? (
        <p className="m-0 mt-2">
          <NotMeasured>Starts with the first pick.</NotMeasured>
        </p>
      ) : (
        <>
          <p className="m-0 mt-2 text-base">
            {v.value ? <Money micro={v.value.micro} /> : null}{" "}
            {v.sinceStartPpm !== null ? (
              <GainLoss
                value={v.sinceStartPpm}
              >{`${pctText(v.sinceStartPpm)} since the start`}</GainLoss>
            ) : null}
          </p>
          {v.cash && v.seed ? (
            <p className="m-0 mt-1 text-text-muted">
              Started with <Money micro={v.seed.micro} />; cash <Money micro={v.cash.micro} />
              {v.asOfD ? `, end of day ${formatDate(v.asOfD)}` : ""}.
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
                      bought at <Money micro={h.entry.micro} />
                      {h.entryD ? ` on ${formatDate(h.entryD)}` : ""}
                    </>
                  ) : null}
                  {h.now ? (
                    <>
                      , now <Money micro={h.now.micro} />
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
