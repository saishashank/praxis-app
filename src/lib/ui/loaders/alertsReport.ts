// Monthly alerts report loader (M17 WP9; VAL-118, VAL-119, D-396, D-467). Descriptive only: counts and
// mean excess returns of intraday candidates by month, the stream state and the pre-registered
// hypothesis. Aggregates only, so there is no code or money amount to mask. Every figure is shadow and
// unvalidated; with no data each part says "No data yet".
import "server-only";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { activeStreamCell, MIN_CANDIDATES, MIN_SESSIONS } from "@/lib/intraday/evaluator";

export type AlertsMonth = {
  readonly month: string;
  readonly found: number;
  readonly nightPick: number;
  readonly rejected: number;
  readonly notInUniverse: number;
  readonly measured: number;
  /** Mean excess return, ppm, of the measured candidates; null when none. */
  readonly meanOpen1: number | null;
  readonly meanOpen3: number | null;
  readonly meanOpen5: number | null;
  readonly meanFound5: number | null;
};

export type AlertsReport = {
  readonly state: string;
  readonly hypothesis: string | null;
  readonly verdict: "pending" | "passed" | "failed";
  readonly candidates: number;
  readonly sessions: number;
  readonly minCandidates: number;
  readonly minSessions: number;
  readonly months: AlertsMonth[];
};

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function loadAlertsReport(db: Client, market: string): Promise<AlertsReport> {
  const rows = (
    await db.execute({
      sql: `SELECT session_d, decision_outcome AS o, excess_open_1_ppm AS a, excess_open_3_ppm AS b,
              excess_open_5_ppm AS c, excess_found_5_ppm AS f
            FROM intraday_candidate WHERE market = ? ORDER BY session_d`,
      args: [market],
    })
  ).rows;
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) {
    const m = String(r.session_d).slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
  }
  const nums = (rs: typeof rows, k: string): number[] =>
    rs.filter((r) => r[k] !== null).map((r) => Number(r[k]));
  const months = [...byMonth.entries()]
    .sort((x, y) => (x[0] < y[0] ? 1 : -1))
    .map(([month, rs]): AlertsMonth => {
      const out = (r: (typeof rows)[number]) => (r.o === null ? "" : String(r.o));
      return {
        month,
        found: rs.length,
        nightPick: rs.filter((r) => out(r) === "night_pick").length,
        rejected: rs.filter((r) => out(r).startsWith("rejected:")).length,
        notInUniverse: rs.filter((r) => out(r) === "not_in_universe").length,
        measured: nums(rs, "c").length,
        meanOpen1: mean(nums(rs, "a")),
        meanOpen3: mean(nums(rs, "b")),
        meanOpen5: mean(nums(rs, "c")),
        meanFound5: mean(nums(rs, "f")),
      };
    });
  const measured = rows.filter((r) => r.c !== null);
  const cell = await activeStreamCell(db, market);
  const spec = cell?.spec as { hypothesis?: string } | null | undefined;
  const result = cell?.result as { passed?: boolean } | null | undefined;
  return {
    state: String(await getConfig(db, "intraday_stream_state")),
    hypothesis: spec?.hypothesis ?? null,
    verdict: result == null ? "pending" : result.passed === true ? "passed" : "failed",
    candidates: measured.length,
    sessions: new Set(measured.map((r) => String(r.session_d))).size,
    minCandidates: MIN_CANDIDATES,
    minSessions: MIN_SESSIONS,
    months,
  };
}
