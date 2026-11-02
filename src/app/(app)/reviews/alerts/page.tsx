// Monthly alerts report (M17 WP9; VAL-118, VAL-119, D-396, D-467): how the intraday candidates fared,
// by month, in plain words. Descriptive only. Every figure is shadow and unvalidated: the intraday
// stream trades nothing and stays shadow until a pre-registered test passes and the Owner approves.
import { requireUser } from "@/lib/auth/guard";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { loadAlertsReport } from "@/lib/ui/loaders/alertsReport";
import { envFor, marketOf } from "@/lib/ui/loaders/shell";
import { alertsReportView, pctText } from "./view";

export const dynamic = "force-dynamic";

export default async function AlertsReportPage() {
  const user = await requireUser("read", "/reviews/alerts");
  const env = await envFor(user);
  const view = alertsReportView(await loadAlertsReport(env.main, marketOf(env)));
  return (
    <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Monthly alerts report</h1>
        <p className="m-0 text-sm text-text-muted">
          How the stocks flagged during the day went afterwards. Shadow, unvalidated numbers: they
          trade nothing and are not advice.
        </p>
      </header>
      <Banner tone="info">{view.banner}</Banner>
      <Card title="Is the intraday idea proven?">
        <p className="m-0 text-sm">{view.verdictText}</p>
        <p className="m-0 mt-2 text-sm text-text-muted">{view.progressText}</p>
        {view.hypothesis !== null ? (
          <p className="m-0 mt-2 text-sm text-text-muted">Test set in advance: {view.hypothesis}</p>
        ) : null}
      </Card>
      {view.months.length === 0 ? (
        <EmptyState title="No data yet">
          No stock has been flagged during the day yet. This page fills in as flagged stocks are
          followed up for five sessions.
        </EmptyState>
      ) : (
        view.months.map((m) => (
          <Card key={m.month} title={m.month} headingLevel={2}>
            <p className="m-0 text-sm">
              {m.found} flagged; {m.nightPick} became a night pick, {m.rejected} were passed over,{" "}
              {m.notInUniverse} were outside the stocks the system studies. {m.measured} have a
              five-session result.
            </p>
            <dl className="m-0 mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-text-muted">After 1 session</dt>
              <dd className="m-0">{pctText(m.meanOpen1)}</dd>
              <dt className="text-text-muted">After 3 sessions</dt>
              <dd className="m-0">{pctText(m.meanOpen3)}</dd>
              <dt className="text-text-muted">After 5 sessions</dt>
              <dd className="m-0">{pctText(m.meanOpen5)}</dd>
              <dt className="text-text-muted">5 sessions, from the alert</dt>
              <dd className="m-0">{pctText(m.meanFound5)}</dd>
            </dl>
            <p className="m-0 mt-2 text-xs text-text-muted">
              Average gain or loss beyond the market, from the next open unless stated. Stocks are
              flagged on the move after taking off the sector&apos;s move where that is known (at
              least 5 stocks in the industry), else on the raw move. Shadow, unvalidated.
            </p>
          </Card>
        ))
      )}
    </main>
  );
}
