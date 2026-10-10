// System Health (PLT-061, PLT-017, UX-090/092/117). Every role may read status; secrets status,
// error details are Owner-only (ROL-102a) and never show values (SEC-101).
import Link from "next/link";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import {
  getHealthSummary,
  type HealthSummary,
  type JobState,
  type QuotaSummary,
} from "@/lib/health/summary";
import type { MeterLevel } from "@/lib/usage/meters";

export const dynamic = "force-dynamic";

const PLACEHOLDERS: { label: string; note: string }[] = [
  { label: "Sentinel last poll", note: "M2" },
  { label: "Data freshness (last bar date per feed)", note: "M2" },
  { label: "LLM provider status", note: "M5" },
  { label: "Last backup", note: "M2" },
  { label: "Last restore test", note: "M2" },
  { label: "Last email", note: "M5" },
];

const STATE_LABEL: Record<JobState, string> = {
  ok: "OK",
  stale: "STALE",
  failed: "FAILED",
  "no data": "NO DATA",
};

const QUOTA_LABEL: Record<MeterLevel, string> = {
  ok: "OK",
  notice: "NOTICE",
  alert: "ALERT",
  degrade: "DEGRADE",
  "no data": "NO DATA",
};

function quotaText(q: QuotaSummary | undefined): string {
  if (!q) return "Not available";
  const base = `Worst level: ${QUOTA_LABEL[q.level]}`;
  return q.meter !== undefined && q.ratio !== undefined
    ? `${base} (${q.meter}, ${(q.ratio * 100).toFixed(1)}%)`
    : base;
}

export default async function HealthPage() {
  const user = await requireUser("read", "/health");
  const tf = (await userPreferences(user.id)).time_format;
  let summary: HealthSummary | null = null;
  try {
    summary = await getHealthSummary(mainDb(), new Date(), user.role);
  } catch {
    summary = null; // neutral message below; no error details
  }
  const owner = user.role === "owner";

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">System Health</h1>
        <p className="text-sm text-muted">Times are shown in Australia/Melbourne.</p>
        <Link href="/" className="text-sm text-accent underline">
          Home
        </Link>
      </header>

      {summary === null ? (
        <p role="status">Health data unavailable</p>
      ) : (
        <>
          <section aria-labelledby="jobs-h" className="flex flex-col gap-3">
            <h2 id="jobs-h" className="text-xl font-semibold">
              Jobs
            </h2>
            <p className="text-sm text-muted">
              A job is flagged stale when its last success is older than twice its expected
              interval.
            </p>
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Job freshness</caption>
              <thead>
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Job
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    State
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Last success
                  </th>
                  {owner && (
                    <th scope="col" className="py-2">
                      Error details
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {summary.jobs.map((j) => (
                  <tr key={j.job} className="border-t border-black/10">
                    <th scope="row" className="py-2 pr-4 font-medium">
                      {j.label}
                    </th>
                    <td className="py-2 pr-4">
                      <span className="rounded border px-2 py-0.5 font-mono text-xs">
                        {STATE_LABEL[j.state]}
                      </span>
                      {j.note && <span className="ml-2 text-muted">{j.note}</span>}
                      {j.stale && j.state !== "stale" && (
                        <span className="ml-2 font-medium">Also stale</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{formatMelbourne(j.lastSuccessAt, tf)}</td>
                    {owner && <td className="py-2">{j.errorSummary ?? "None"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {owner && summary.secrets && (
            <section aria-labelledby="secrets-h" className="flex flex-col gap-3">
              <h2 id="secrets-h" className="text-xl font-semibold">
                Secrets status
              </h2>
              <p className="text-sm text-muted">
                Last verified: {formatMelbourne(summary.secrets.lastVerifiedAt, tf)}. Values are
                never shown.
              </p>
              {summary.secrets.results.length === 0 ? (
                <p>No self-check has been recorded yet.</p>
              ) : (
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Secrets status</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-2 pr-4">
                        Secret check
                      </th>
                      <th scope="col" className="py-2 pr-4">
                        Result
                      </th>
                      <th scope="col" className="py-2">
                        Detail
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.secrets.results.map((r) => (
                      <tr key={r.name} className="border-t border-black/10">
                        <th scope="row" className="py-2 pr-4 font-medium">
                          {r.name}
                        </th>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {r.pending ? "PENDING" : r.ok ? "PASS" : "FAIL"}
                        </td>
                        <td className="py-2">{r.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}

      <section aria-labelledby="more-h" className="flex flex-col gap-3">
        <h2 id="more-h" className="text-xl font-semibold">
          Other status
        </h2>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="flex flex-col">
            <dt className="font-medium">Quota usage</dt>
            <dd className="text-muted">{quotaText(summary?.quota)}</dd>
          </div>
          {PLACEHOLDERS.map((p) => (
            <div key={p.label} className="flex flex-col">
              <dt className="font-medium">{p.label}</dt>
              <dd className="text-muted">Not available yet ({p.note})</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="text-xs text-muted">
        Simulation for personal information only — not financial advice
      </footer>
    </main>
  );
}
