// Usage (PLT-050, PLT-051, UX-100). Owner-only (ROL-102a): every figure is self-counted from our
// own run records and labelled as an estimate.
import { EmptyState } from "@/components/ui/States";
import Link from "next/link";
import { Pill } from "@/components/ui/Pill";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { loadBakeoffResults, type BakeoffView } from "@/lib/ui/loaders/usageBakeoff";
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

// Level to pill kind and the colour of the bar (status colours, never the gain/loss pair).
const LEVEL_PILL: Record<MeterLevel, string> = {
  ok: "ok",
  notice: "warn",
  alert: "bad",
  degrade: "bad",
  "no data": "neutral",
};
const LEVEL_BAR: Record<MeterLevel, string> = {
  ok: "var(--gradient-brand)",
  notice: "var(--color-tier-p1-fill)",
  alert: "var(--color-negative-fill)",
  degrade: "var(--color-negative-fill)",
  "no data": "var(--color-grid)",
};

const nf = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 });
const pctText = (v: number | null) => (v === null ? "n/a" : `${v}%`);
const whole = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const amount = (v: number | null, unit: string) => (v === null ? "n/a" : `${nf.format(v)} ${unit}`);

/** One meter as a row (UXR-029): name, period, a progress bar, used / limit and the level pill. */
function MeterRow({ m }: { m: Meter }) {
  const pct = m.ratio === null ? null : Math.max(0, Math.min(100, m.ratio * 100));
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{m.label}</h3>
        <Pill kind="status" value={LEVEL_PILL[m.level]}>
          {LEVEL_LABEL[m.level]}
        </Pill>
      </div>
      <div
        role="progressbar"
        aria-label={`${m.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={pct === null ? "No data" : `${pct.toFixed(1)}% of the limit`}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      >
        <div
          data-level={m.level}
          className="h-full rounded-full"
          style={{ width: `${pct ?? 0}%`, background: LEVEL_BAR[m.level] }}
        />
      </div>
      <p className="m-0 text-sm">
        {m.used === null ? "No data" : amount(m.used, m.unit)} / {amount(m.limit, m.unit)}
        {m.ratio !== null && ` (${(m.ratio * 100).toFixed(1)}%)`}
      </p>
      <p className="m-0 text-xs text-text-muted">
        <span>{m.periodLabel}</span>. {m.note}
      </p>
    </li>
  );
}

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
  let bakeoff: BakeoffView | null | "unavailable" = null;
  try {
    bakeoff = await loadBakeoffResults(mainDb(), user.role);
  } catch {
    bakeoff = "unavailable"; // neutral message below; no error details
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-text-muted">
          How much of each free-tier allowance has been used, so nothing runs out unnoticed. As of{" "}
          {formatMelbourne(now.toISOString(), tf)}. Quota periods are UTC calendar months (days for
          LLM tokens). Times are shown in Australia/Melbourne.
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
          <ul aria-label="Free-tier usage meters" className="m-0 flex list-none flex-col gap-3 p-0">
            {meters.map((m) => (
              <MeterRow key={m.id} m={m} />
            ))}
          </ul>
        </section>
      )}

      <LlmSection llm={llm} />

      <BakeoffSection bakeoff={bakeoff} />

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

/**
 * The models that actually answered, by role (D-174, Owner: "LLM info read-only and specific, like
 * the LLM name"). Read-only, from the call log; nothing here can be changed from the UI.
 */
function ModelsInUse({ llm }: { llm: LlmUsage }) {
  return (
    <div className="ui-card min-w-0 rounded-lg border border-border bg-surface p-4">
      <h3 className="m-0 text-base font-semibold">Models in use</h3>
      {llm.models.length === 0 ? (
        <p className="m-0 mt-2 text-sm text-text-muted">
          None. No AI model has answered since {llm.sinceD}; every text is written by the fixed
          rules. A model is used only after it passes the bake-off and is switched on.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Models that answered since {llm.sinceD}</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4">
                  Role
                </th>
                <th scope="col" className="py-2 pr-4">
                  Provider
                </th>
                <th scope="col" className="py-2 pr-4">
                  Model
                </th>
                <th scope="col" className="py-2 pr-4">
                  Calls
                </th>
                <th scope="col" className="py-2">
                  Last used
                </th>
              </tr>
            </thead>
            <tbody>
              {llm.models.map((m) => (
                <tr key={`${m.role}|${m.provider}|${m.model}`} className="border-t border-border">
                  <th scope="row" className="py-2 pr-4 font-medium">
                    {m.role}
                  </th>
                  <td className="py-2 pr-4">{m.provider}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{m.model}</td>
                  <td className="py-2 pr-4">{m.calls}</td>
                  <td className="py-2">{m.lastD}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
      {llm !== null && <ModelsInUse llm={llm} />}
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

/** LLM-042: the stored results of the latest bake-off run (Owner only; the loader checks the role). */
function BakeoffSection({ bakeoff }: { bakeoff: BakeoffView | null | "unavailable" }) {
  return (
    <section aria-labelledby="bakeoff-h" className="flex flex-col gap-3">
      <h2 id="bakeoff-h" className="text-xl font-semibold">
        Model bake-off
      </h2>
      {bakeoff === "unavailable" ? (
        <p role="status">Bake-off results unavailable</p>
      ) : bakeoff === null ? (
        <EmptyState compact motif="list" hue="home" title="No bake-off has run yet." />
      ) : (
        <>
          <p className="text-sm text-text-muted">
            Run <span className="font-mono">{bakeoff.runId}</span>, report{" "}
            <span className="font-mono">{bakeoff.reportSha.slice(0, 12)}</span>. A model passes only
            when it meets every threshold on the golden set.
          </p>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Bake-off results per model and category</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4">
                  Model
                </th>
                <th scope="col" className="py-2 pr-4">
                  Category
                </th>
                <th scope="col" className="py-2 pr-4">
                  Valid JSON
                </th>
                <th scope="col" className="py-2 pr-4">
                  Invented numbers
                </th>
                <th scope="col" className="py-2 pr-4">
                  Injection resisted
                </th>
                <th scope="col" className="py-2 pr-4">
                  Result
                </th>
                <th scope="col" className="py-2">
                  Training policy checked
                </th>
              </tr>
            </thead>
            <tbody>
              {bakeoff.lines.map((l) => (
                <tr key={`${l.modelId}|${l.category}`} className="border-t border-border align-top">
                  <th scope="row" className="py-2 pr-4 font-mono font-medium">
                    {l.modelId}
                  </th>
                  <td className="py-2 pr-4">{l.category}</td>
                  <td className="py-2 pr-4">{pctText(l.jsonValidPct)}</td>
                  <td className="py-2 pr-4">{whole.format(l.inventedNumbers)}</td>
                  <td className="py-2 pr-4">{pctText(l.injectionResistancePct)}</td>
                  <td className="py-2 pr-4">{l.passes ? "Passes" : "Does not pass"}</td>
                  <td className="py-2">{l.trainsOnPromptsCheckedD ?? "Not checked"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
