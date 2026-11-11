// D-950 "My portfolio" on Home and the Picks page: the three practice portfolios side by side, one
// per risk profile, each with its value, profit or loss, worst fall, holdings and strategy split.
import type { MyPortfolio, MyPortfoliosView } from "@/lib/ui/loaders/pickPortfolio";
import { GainLoss, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDay, formatMicro, formatPpm } from "@/lib/view/format";
import { profileLabel } from "./text";

const pctText = (ppm: number | null) =>
  ppm === null ? null : formatPpm(ppm, { digits: 1, sign: "always" });

const PROFILE_NOTE: Record<string, string> = {
  conservative: "Largest shares, small risk per stock, more cash when picks are weak.",
  balanced: "The strategies in the ratio their records earn.",
  aggressive: "Smaller companies too, leans harder to the winning strategies.",
};

function One({ v }: { v: MyPortfolio }) {
  const id = `portfolio-${v.profile}-h`;
  return (
    <div
      role="group"
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-1 break-words rounded-md border border-border p-3"
      data-testid={`my-portfolio-${v.profile}`}
    >
      <h3 id={id} className="m-0 text-base font-semibold">
        {profileLabel(v.profile)}
      </h3>
      <p className="m-0 text-xs text-text-muted">{PROFILE_NOTE[v.profile] ?? ""}</p>
      {!v.started ? (
        <p className="m-0 mt-1">
          <NotMeasured>Starts with the first pick.</NotMeasured>
        </p>
      ) : (
        <>
          <p className="m-0 mt-1 text-base">
            {v.value ? <Money micro={v.value.micro} /> : null}{" "}
            {v.sinceStartPpm !== null ? (
              <GainLoss value={v.sinceStartPpm}>
                {v.gain
                  ? `${formatMicro(v.gain.micro, { sign: "always" })} (${pctText(v.sinceStartPpm)})`
                  : `${pctText(v.sinceStartPpm)}`}
              </GainLoss>
            ) : null}
          </p>
          <p className="m-0 text-text-muted">
            Worst fall from a peak:{" "}
            {v.worstFallPpm !== null && v.worstFallPpm < 0
              ? formatPpm(v.worstFallPpm, { digits: 1 })
              : "none yet"}
            .
          </p>
          {v.cash ? (
            <p className="m-0 text-text-muted">
              Cash <Money micro={v.cash.micro} />
              {v.asOfD ? `, end of day ${formatDay(v.asOfD)}` : ""}.
            </p>
          ) : null}
          {v.split ? (
            <p className="m-0" data-testid="portfolio-split">
              <span className="font-medium">Split:</span> {v.split}
            </p>
          ) : null}
          {v.splitWhy ? <p className="m-0 text-xs text-text-muted">{v.splitWhy}</p> : null}
          {v.holdings.length > 0 ? (
            <ul
              className="m-0 mt-1 flex list-none flex-col gap-1 p-0"
              aria-label={`${profileLabel(v.profile)} holdings`}
            >
              {v.holdings.map((h, i) => (
                <li key={`${h.stock}-${i}`} className="min-w-0 break-words">
                  <strong>{h.stock}</strong> <span className="text-text-muted">({h.strategy})</span>
                  {h.entry ? (
                    <>
                      {" "}
                      bought at <Money micro={h.entry.micro} />
                      {h.entryD ? ` on ${formatDay(h.entryD)}` : ""}
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
            <p className="m-0 mt-1 text-text-muted">All in cash: waiting for a good pick.</p>
          )}
          <p className="m-0 text-text-muted">
            {v.closed === 0
              ? "No holding sold in full yet."
              : `${v.closed} sold, ${v.wins} with a gain (${Math.round((100 * v.wins) / v.closed)}%).`}
          </p>
          {v.trades.length > 0 ? (
            <details className="text-text-muted">
              <summary className="cursor-pointer font-medium">Latest trades</summary>
              <ul className="m-0 mt-1 list-disc pl-5">
                {v.trades.map((t, i) => (
                  <li key={i} className="break-words">
                    {t.d ? `${formatDay(t.d)}: ` : ""}
                    <strong>{t.stock}</strong>. {t.words}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

export function PortfolioCard({ v }: { v: MyPortfoliosView }) {
  return (
    <section
      aria-labelledby="portfolio-h"
      className="min-w-0 break-words rounded-lg border border-border bg-surface p-4 text-sm"
      data-testid="pick-portfolio"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="portfolio-h" className="m-0 text-lg font-semibold">
          My portfolio
        </h2>
        {!v.masked ? <SimulatedLabel /> : null}
      </div>
      <p className="m-0 mt-1 text-text-muted">
        Three practice portfolios, one per risk profile
        {v.seed ? (
          <>
            , each started with <Money micro={v.seed.micro} />
          </>
        ) : null}
        . Each buys from every strategy&apos;s picks and shares its money by their records.
      </p>
      <details className="mt-1 text-text-muted">
        <summary className="cursor-pointer font-medium">How they trade</summary>
        <ul className="m-0 mt-1 list-disc pl-5">
          <li>
            Each strategy gets a share by its finished picks, close to equal while its record is
            short, less when its results swing more, at most {v.strategyMaxPct}% each; the rest
            waits as cash.
          </li>
          <li>
            Buys a strategy&apos;s best picks that fit its share, at most {v.stockMaxPct}% in one
            stock.
          </li>
          <li>Skips a buy when the trading fees would be too large a part of it.</li>
          <li>
            Sells at the stop-loss, at the aim, when the time frame ends, when the stock is weak
            with no signal, or when its strategy gives its sell signal.
          </li>
          <li>Trims a strategy only when it drifts well past its share.</li>
          {v.masked ? null : (
            <li>Practice sizes: a real first buy of a share on the ASX needs at least A$500.</li>
          )}
        </ul>
      </details>
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
        {v.portfolios.map((p) => (
          <One key={p.profile} v={p} />
        ))}
      </div>
    </section>
  );
}
