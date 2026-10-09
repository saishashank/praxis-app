// Usage (PLT-050, PLT-051, UX-100). Owner-only (ROL-102a): every figure is self-counted from our
// own run records and labelled as an estimate.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import {
  getMeters,
  usageEnvironment,
  worstMeter,
  type Meter,
  type MeterLevel,
} from "@/lib/usage/meters";

export const dynamic = "force-dynamic";

const LEVEL_LABEL: Record<MeterLevel, string> = {
  ok: "OK",
  notice: "NOTICE",
  alert: "ALERT",
  degrade: "DEGRADE",
  "no data": "NO DATA",
};

const nf = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 });
const amount = (v: number | null, unit: string) => (v === null ? "n/a" : `${nf.format(v)} ${unit}`);

export default async function UsagePage() {
  await requireUser("admin", "/usage");
  const now = new Date();
  let meters: Meter[] | null = null;
  try {
    meters = await getMeters(mainDb(), now, usageEnvironment(process.env));
  } catch {
    meters = null; // neutral message below; no error details
  }
  const worst = meters ? worstMeter(meters) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-muted">
          As of {formatMelbourne(now.toISOString())}. Quota periods are UTC calendar months (days
          for LLM tokens). Times are shown in Australia/Melbourne.
        </p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {meters === null || worst === null ? (
        <p role="status">Usage data unavailable</p>
      ) : (
        <section aria-labelledby="meters-h" className="flex flex-col gap-3">
          <h2 id="meters-h" className="text-xl font-semibold">
            Free-tier meters
          </h2>
          <p className="text-sm text-muted">
            Worst level: <span className="font-mono">{LEVEL_LABEL[worst.level]}</span>. Notice at
            70%, alert at 90%, degrade at 95% of a monthly limit. Figures are recorded by jobs (app
            traffic is not included), so compare them with the provider dashboards during the
            monthly $0 check.
          </p>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Free-tier usage meters</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4">
                  Meter
                </th>
                <th scope="col" className="py-2 pr-4">
                  Period
                </th>
                <th scope="col" className="py-2 pr-4">
                  Used / limit
                </th>
                <th scope="col" className="py-2 pr-4">
                  Level
                </th>
                <th scope="col" className="py-2">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {meters.map((m) => (
                <tr key={m.id} className="border-t border-black/10 align-top">
                  <th scope="row" className="py-2 pr-4 font-medium">
                    {m.label}
                  </th>
                  <td className="py-2 pr-4">{m.periodLabel}</td>
                  <td className="py-2 pr-4">
                    {m.used === null ? "No data" : amount(m.used, m.unit)} /{" "}
                    {amount(m.limit, m.unit)}
                    {m.ratio !== null && ` (${(m.ratio * 100).toFixed(1)}%)`}
                  </td>
                  <td className="py-2 pr-4">
                    <span className="rounded border px-2 py-0.5 font-mono text-xs">
                      {LEVEL_LABEL[m.level]}
                    </span>
                  </td>
                  <td className="py-2 text-muted">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="text-xs text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}
