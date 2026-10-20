// Usage (PLT-050, PLT-051, UX-100). Owner-only (ROL-102a): every figure is self-counted from our
// own run records and labelled as an estimate.
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { loadLlmUsage, type LlmCounts, type LlmUsage } from "@/lib/ui/loaders/usageLlm";
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
const pctText = (v: number | null) => (v === null ? "n/a" : `${v}%`);
const whole = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const amount = (v: number | null, unit: string) => (v === null ? "n/a" : `${nf.format(v)} ${unit}`);

export default async function UsagePage() {
  const user = await requireUser("admin", "/usage");
  const tf = (await userPreferences(user.id)).time_format;
  const now = new Date();
  let meters: Meter[] | null = null;
  try {
    meters = await getMeters(mainDb(), now, usageEnvironment(process.env));
  } catch {
    meters = null; // neutral message below; no error details
  }
  const worst = meters ? worstMeter(meters) : null;
  let llm: LlmUsage | null = null;
  try {
    llm = await loadLlmUsage(mainDb(), user.role, now);
  } catch {
    llm = null; // neutral message below; no error details
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-text-muted">
          As of {formatMelbourne(now.toISOString(), tf)}. Quota periods are UTC calendar months
          (days for LLM tokens). Times are shown in Australia/Melbourne.
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
          <p className="text-sm text-text-muted">
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
                <tr key={m.id} className="border-t border-border align-top">
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
                  <td className="py-2 text-text-muted">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <LlmSection llm={llm} />

      <footer className="text-xs text-text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}

function CountCells({ c }: { c: LlmCounts }) {
  return (
    <>
      <td className="py-2 pr-4 text-right font-mono">{whole.format(c.calls)}</td>
      <td className="py-2 pr-4 text-right font-mono">
        {whole.format(c.tokensIn)} / {whole.format(c.tokensOut)}
      </td>
      <td className="py-2 pr-4 text-right font-mono">{pctText(c.cachePct)}</td>
      <td className="py-2 pr-4 text-right font-mono">{pctText(c.fallbackPct)}</td>
      <td className="py-2 text-right font-mono">{whole.format(c.failures)}</td>
    </>
  );
}

const COUNT_HEADS = ["Calls", "Tokens in / out", "Cache hits", "Fallbacks", "Failures"];

function Heads({ first }: { first: string }) {
  return (
    <tr>
      <th scope="col" className="py-2 pr-4">
        {first}
      </th>
      <th scope="col" className="py-2 pr-4">
        Provider
      </th>
      {COUNT_HEADS.map((h) => (
        <th key={h} scope="col" className="py-2 pr-4 text-right">
          {h}
        </th>
      ))}
    </tr>
  );
}

// LLM usage (LLM-051): tokens and requests per provider, role and day, cache hit rate, fallback rate
// and failures. Counted from our own call log; no prompt or answer text is stored there.
function LlmSection({ llm }: { llm: LlmUsage | null }) {
  return (
    <section aria-labelledby="llm-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="llm-h" className="text-xl font-semibold">
        LLM usage
      </h2>
      {llm === null ? (
        <p>LLM usage unavailable</p>
      ) : llm.byRole.length === 0 ? (
        <p>
          No LLM calls recorded in the last 30 days. The system writes with fixed rules until a
          model is switched on.
        </p>
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Counted from our own call log (estimates). A fallback means a later provider or the
            fixed rules answered because an earlier one could not. A failure ended without a model
            answer (for example the daily budget was used up).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="text-left font-medium">
                By role and provider since {llm.sinceD}
              </caption>
              <thead>
                <Heads first="Role" />
              </thead>
              <tbody>
                {llm.byRole.map((r) => (
                  <tr key={`${r.role}|${r.provider}`} className="border-t border-border">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {r.role}
                    </th>
                    <td className="py-2 pr-4">{r.provider}</td>
                    <CountCells c={r} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="text-left font-medium">
                By day and provider (newest first)
              </caption>
              <thead>
                <Heads first="Day (UTC)" />
              </thead>
              <tbody>
                {llm.byDay.map((r) => (
                  <tr key={`${r.d}|${r.provider}`} className="border-t border-border">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {r.d}
                    </th>
                    <td className="py-2 pr-4">{r.provider}</td>
                    <CountCells c={r} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
