// Plain-words view model of the monthly alerts report (pure; tested in AT-63 d).
import type { AlertsMonth, AlertsReport } from "@/lib/ui/loaders/alertsReport";

/** ppm as a signed percentage with the shadow label; null is "Not measured yet". */
export function pctText(ppm: number | null): string {
  if (ppm === null) return "Not measured yet";
  const pct = ppm / 10_000; // threshold-ok: ppm to percent
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(2)} % (shadow, unvalidated)`;
}

export type AlertsView = {
  banner: string;
  verdictText: string;
  progressText: string;
  hypothesis: string | null;
  months: AlertsMonth[];
};

export function alertsReportView(r: AlertsReport): AlertsView {
  const verdictText =
    r.verdict === "passed"
      ? "The test passed. The Owner may approve a trading family at the next release. Nothing trades during the day."
      : r.verdict === "failed"
        ? "The test did not pass. The idea stays in shadow: shown, never traded."
        : "Not proven yet. The idea stays in shadow: shown, never traded.";
  return {
    banner: `Stream state: ${r.state}. Every number here is shadow and unvalidated.`,
    verdictText,
    progressText: `Followed for five sessions so far: ${r.candidates} flagged stocks over ${r.sessions} sessions. The test needs at least ${r.minCandidates} stocks over at least ${r.minSessions} sessions.`,
    hypothesis: r.hypothesis,
    months: r.months,
  };
}
