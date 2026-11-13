// Usage > Projection per market (MKT-113, MKT-105, D-1099; M20 S1). Owner only (the page is). One block per built market,
// enabled or not, with its `data-market`: what the market would add each month (the AU trailing-30-day figures scaled by
// its universe cap and its sessions, plus its fixed overhead), the total with AU and every enabled market, the line it
// must stay within, and whether it fits. Estimates, labelled so; nothing is written.
import { Pill } from "@/components/ui/Pill";
import { PROJECTION_METRICS, type ProjectionReport } from "@/lib/usage/projection";

const whole = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });

export function ProjectionSection({ report }: { report: ProjectionReport | null }) {
  return (
    <section
      id="projection"
      aria-labelledby="projection-h"
      data-markets-table=""
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 id="projection-h" className="text-xl font-semibold">
        Projection per market
      </h2>
      {report === null ? (
        <p role="status">Projection unavailable</p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Estimate for the next calendar month, from the last 30 days of AU. A market adds the AU
            figure times (its universe cap / the AU universe of {whole.format(report.auCodes)}{" "}
            codes) times (its trading days / the AU trading days), plus its own fixed overhead.
            Database rows must stay within 20% of the free plan with AU and every enabled market
            added; every other figure within 90% of its budget.
          </p>
          {report.markets.map((m) => {
            const fit = report.fitsWith[m.market];
            return (
              <div
                key={m.market}
                data-market={m.market}
                data-enabled={m.enabled ? "1" : "0"}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="m-0 text-base font-semibold">
                    {m.market} ({m.enabled ? "enabled" : "not switched on"})
                  </h3>
                  {fit !== null && (
                    <Pill kind="status" value={fit.fits ? "ok" : "bad"}>
                      {fit.fits ? "FITS" : "DOES NOT FIT"}
                    </Pill>
                  )}
                </div>
                {m.projected === null || fit === null ? (
                  <p className="m-0 text-sm">No projection: {m.note ?? "not available."}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-left text-sm">
                      <caption className="text-left text-xs text-text-muted">
                        Cap {whole.format(m.cap ?? 0)} codes, {m.sessions} trading days next month
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" className="py-1 pr-4">
                            Figure
                          </th>
                          <th scope="col" className="py-1 pr-4 text-right">
                            This market adds
                          </th>
                          <th scope="col" className="py-1 pr-4 text-right">
                            Total with AU
                          </th>
                          <th scope="col" className="py-1 pr-4 text-right">
                            Line
                          </th>
                          <th scope="col" className="py-1 text-right">
                            Share
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {PROJECTION_METRICS.map((metric) => {
                          const v = fit.verdicts.find((x) => x.metric === metric)!;
                          return (
                            <tr
                              key={metric}
                              data-metric={metric}
                              data-ok={v.ok ? "1" : "0"}
                              className="border-t border-border"
                            >
                              <th scope="row" className="py-1 pr-4 font-medium">
                                {v.label}
                              </th>
                              <td className="py-1 pr-4 text-right font-mono">
                                {whole.format(m.projected![metric])}
                              </td>
                              <td className="py-1 pr-4 text-right font-mono">
                                {whole.format(v.total)}
                              </td>
                              <td className="py-1 pr-4 text-right font-mono">
                                {whole.format(v.limit)}
                              </td>
                              <td className="py-1 text-right font-mono">
                                {one.format(v.sharePct)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
