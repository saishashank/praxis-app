// Tax report page (M21 B3; ARN-122, D-1222, D-1223, D-1265). Owner only and always available; it describes what the paper
// books (or, with the Owner tools on, the Owner's own trade log) realised in one financial year of one market. It is a
// factual report with the fixed words "Paper results, not tax advice" at the top. Read only.
import { forbidden } from "next/navigation";
import { isPinnedOwner } from "@/lib/auth/blueprintGuard";
import { requireUser } from "@/lib/auth/guard";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { enabledMarkets } from "@/lib/market/profile";
import { logVariantAllowed, parseTaxQuery, defaultFy, yearChoices } from "@/lib/tax/access";
import { taxReport } from "@/lib/tax/report";
import type { Disposal, Section, TaxReport, Totals } from "@/lib/tax/types";
import { envFor, todayD } from "@/lib/ui/loaders/shell";
import { currencyFormatFor, formatMicro } from "@/lib/view/format";
import { financialYearLabel } from "@/lib/market/seed/taxYear.mjs";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | null =>
  typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;

function Disposals({
  title,
  section,
  fmt,
}: {
  title: string;
  section: Section;
  fmt: (m: bigint) => string;
}) {
  return (
    <Card title={title} headingLevel={3}>
      {section.disposals.length === 0 ? (
        <p className="m-0 text-sm text-text-muted">No sales in this year.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="text-text-muted">
                <th scope="col">Stock</th>
                <th scope="col">Bought</th>
                <th scope="col">Sold</th>
                <th scope="col">Shares</th>
                <th scope="col">Cost</th>
                <th scope="col">Proceeds</th>
                <th scope="col">Gain or loss</th>
                <th scope="col">Held</th>
              </tr>
            </thead>
            <tbody>
              {section.disposals.map((d: Disposal) => (
                <tr key={`${d.sellId}:${d.lotId}`}>
                  <td>{d.code}</td>
                  <td>{d.buyD}</td>
                  <td>{d.sellD}</td>
                  <td>{d.qty.toString()}</td>
                  <td>{fmt(d.costMicro)}</td>
                  <td>{fmt(d.proceedsMicro)}</td>
                  <td>{fmt(d.gainMicro)}</td>
                  <td>{d.over12Months ? "Over 12 months" : "12 months or less"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <TotalsLine t={section.totals} fmt={fmt} />
    </Card>
  );
}

function TotalsLine({ t, fmt }: { t: Totals; fmt: (m: bigint) => string }) {
  return (
    <p className="m-0 mt-2 text-sm">
      Cost {fmt(t.costMicro)}; proceeds {fmt(t.proceedsMicro)}; net {fmt(t.gainMicro)} (gains{" "}
      {fmt(t.gainsMicro)}, losses {fmt(t.lossesMicro)}). Held over 12 months:{" "}
      {fmt(t.gainOver12Micro)}; 12 months or less: {fmt(t.gain12OrLessMicro)}.
    </p>
  );
}

function ReportBody({ r, fmt }: { r: TaxReport; fmt: (m: bigint) => string }) {
  return (
    <>
      {r.truncated ? (
        <Banner tone="warning">
          The read stopped at its page limit, so these figures are incomplete.
        </Banner>
      ) : null}
      {r.executions.length === 0 ? (
        <EmptyState title="No sales in this year">
          Nothing was sold in this financial year.
        </EmptyState>
      ) : (
        r.executions.map((e) => (
          <section key={e.id} className="flex flex-col gap-3">
            <h2 className="m-0 text-lg font-semibold">
              {r.source === "log" ? "Trade log" : `Strategy ${e.id}`}
            </h2>
            {r.specificEqualsFifo ? null : (
              <Disposals
                title="Specific lot (the buy each sale closed)"
                section={e.specific}
                fmt={fmt}
              />
            )}
            <Disposals title="First in, first out (FIFO)" section={e.fifo} fmt={fmt} />
          </section>
        ))
      )}
      <Card title={`Whole ${r.market} market`} headingLevel={2}>
        {r.specificEqualsFifo ? null : (
          <>
            <p className="m-0 text-sm font-medium">Specific lot</p>
            <TotalsLine t={r.total.specific} fmt={fmt} />
          </>
        )}
        <p className="m-0 mt-2 text-sm font-medium">FIFO</p>
        <TotalsLine t={r.total.fifo} fmt={fmt} />
      </Card>
      {r.closedWithoutPrice.length > 0 ? (
        <Card title="Closed without a sale price" headingLevel={2}>
          <p className="m-0 text-sm text-text-muted">
            These holdings were closed with no sale price recorded (a suspended stock). They have no
            gain or loss here.
          </p>
          <ul className="m-0 mt-2 list-disc pl-5 text-sm">
            {r.closedWithoutPrice.map((c) => (
              <li key={`${c.executionId}:${c.code}:${c.buyD}`}>
                {c.code}, bought {c.buyD}, cost {fmt(c.costMicro)} ({c.executionId})
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r.unmatched.length > 0 ? (
        <Card title="Sales with no earlier buy" headingLevel={2}>
          <p className="m-0 text-sm text-text-muted">
            No cost is assumed for these shares, so they are left out of the figures above.
          </p>
          <ul className="m-0 mt-2 list-disc pl-5 text-sm">
            {r.unmatched.map((u) => (
              <li key={u.sellId}>
                {u.code}, sold {u.sellD}, {u.qty.toString()} shares
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r.writtenOff.length > 0 ? (
        <Card title="Shares removed by a corporate action" headingLevel={2}>
          <ul className="m-0 list-disc pl-5 text-sm">
            {r.writtenOff.map((w) => (
              <li key={`${w.lotId}:${w.exD}`}>
                {w.code}, {w.exD}, cost {fmt(w.costMicro)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r.source === "book" ? (
        <Card title="Dividends paid" headingLevel={2}>
          {r.dividends.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">No dividends were paid in this year.</p>
          ) : (
            <ul className="m-0 list-disc pl-5 text-sm">
              {r.dividends.map((x) => (
                <li key={`${x.executionId}:${x.code}:${x.d}:${x.amountMicro}`}>
                  {x.code}, paid {x.d}: {fmt(x.amountMicro)};{" "}
                  {x.frankingPct === null && x.frankingCreditMicro === null
                    ? "franking not recorded"
                    : `franking ${x.frankingPct ?? "not recorded"}%, credit ${x.frankingCreditMicro === null ? "not recorded" : fmt(x.frankingCreditMicro)}`}
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 mt-2 text-sm">Total paid: {fmt(r.dividendTotalMicro)}</p>
        </Card>
      ) : null}
    </>
  );
}

export default async function TaxReportPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser("admin", "/reviews/tax");
  if (!isPinnedOwner(user, process.env)) forbidden(); // the Blueprint rule: the pinned Owner only
  const sp = await searchParams;
  const env = await envFor(user, new Date(), first(sp.market));
  const q = parseTaxQuery((k) => first(sp[k]));
  const logAllowed = await logVariantAllowed(user);
  const source = q.source === "log" && logAllowed ? "log" : "book";
  const fy = q.fy ?? defaultFy(env.market, todayD(env));
  const report = await taxReport(env.main, { market: env.market, fy, source });
  const cf = currencyFormatFor(env.currency);
  const fmt = (m: bigint) => formatMicro(m, cf);
  const markets = await enabledMarkets(env.main);
  const csvQuery = `market=${encodeURIComponent(env.market)}&fy=${fy}&source=${source}`;
  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Tax report</h1>
        <p className="m-0 text-sm font-medium">{report.words}</p>
        <p className="m-0 text-sm text-text-muted">
          {report.heading}. {env.market} financial year {report.fyLabel}. Sales are placed in the
          year they were made.
        </p>
      </header>
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        {markets.length > 1 ? (
          <label className="flex flex-col gap-1">
            Market
            <select
              name="market"
              defaultValue={env.market}
              className="rounded border border-border bg-surface px-2 py-1"
            >
              {markets.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          Financial year
          <select
            name="fy"
            defaultValue={String(fy)}
            className="rounded border border-border bg-surface px-2 py-1"
          >
            {yearChoices(defaultFy(env.market, todayD(env))).map((y) => (
              <option key={y} value={y}>
                {financialYearLabel(env.market, y)}
              </option>
            ))}
          </select>
        </label>
        {logAllowed ? (
          <label className="flex flex-col gap-1">
            Based on
            <select
              name="source"
              defaultValue={source}
              className="rounded border border-border bg-surface px-2 py-1"
            >
              <option value="book">The paper books</option>
              <option value="log">Your own trade log</option>
            </select>
          </label>
        ) : null}
        <button type="submit" className="rounded border border-border px-3 py-1">
          Show
        </button>
        <a className="underline" href={`/api/reports/tax?${csvQuery}`} download>
          Download CSV
        </a>
      </form>
      <ul className="m-0 list-disc pl-5 text-sm text-text-muted">
        {report.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <ReportBody r={report} fmt={fmt} />
    </main>
  );
}
