// D-1067 (Owner O-84): storage of the pick scorecard. Two write-once tables (migration 0033) and ONE
// trial-ledger row per run, kind `report_look` (a report-only look at the sealed holdout; it counts
// toward no budget, no holdout use and no disagreement-night count). Every write is INSERT OR IGNORE in
// batches (the run row last, so a half-written run is never the "latest"); no OFFSET, no read of a
// table that a learner, the Cortex or the arena writes.
import type { Client, InStatement } from "@libsql/client";
import { trialLedgerRow } from "@/lib/stats/splits";
import { parseSummary, type DayResult, type ScorecardSummary } from "./pickScorecard";

const BATCH = 200; // threshold-ok: statements per DB batch (the replay CLI's chunk)

export type ScorecardRun = {
  readonly id: string;
  readonly market: string;
  readonly createdAt: string;
  readonly commitSha: string;
  readonly sessions: number;
  readonly firstD: string;
  readonly lastD: string;
  readonly status: "complete" | "partial";
  readonly summary: ScorecardSummary;
};

/** The lineage the report-only look is filed under (never a real strategy lineage). */
export const REPORT_LINEAGE = (market: string): string => `${market}:pick-scorecard`;
export const REPORT_VARIANT = "pick-scorecard";

export const scorecardRunId = (
  market: string,
  lastD: string,
  sessions: number,
  snapshotSha: string,
  commitSha: string,
): string =>
  `pickscore:${market}:${lastD}:${sessions}:${snapshotSha.slice(0, 8)}:${commitSha.slice(0, 8)}`;

export async function scorecardExists(db: Client, id: string): Promise<boolean> {
  const r = await db.execute({ sql: "SELECT 1 FROM pick_scorecard_run WHERE id = ?", args: [id] });
  return r.rows.length > 0;
}

/** Write a run: day rows, the one trial-ledger look, then the run row. Returns the statements written. */
export async function persistScorecard(
  db: Client,
  run: ScorecardRun,
  days: readonly DayResult[],
): Promise<number> {
  const stmts: InStatement[] = days.map((d) => ({
    sql: `INSERT OR IGNORE INTO pick_scorecard_day (run_id, d, next_d, picks_n, gainers_n, gainer_hits,
            losers_n, loser_hits, liquid_n, named_n, chance_ppm, cortex_scored, cortex_gainers_in_top,
            cortex_losers_in_bottom, cortex_gap_ppm, profiles_json, detail_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      d.d,
      d.nextD,
      d.picksN,
      d.gainersN,
      d.gainerHits,
      d.losersN,
      d.loserHits,
      d.liquidN,
      d.namedN,
      d.chancePpm,
      d.cortex?.scored ?? 0,
      d.cortex?.gainersInTop ?? null,
      d.cortex?.losersInBottom ?? null,
      d.cortex?.gapPpm ?? null,
      JSON.stringify(d.profiles),
      JSON.stringify(d.detail),
    ],
  }));
  const look = trialLedgerRow({
    market: run.market,
    lineage_id: REPORT_LINEAGE(run.market),
    split_version: 0,
    kind: "report_look",
    rule_version: null,
    variant: REPORT_VARIANT,
    run_id: run.id,
    d: run.lastD,
  });
  stmts.push({
    sql: `INSERT OR IGNORE INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version,
            variant, run_id, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      look.id,
      look.market,
      look.lineage_id,
      look.split_version,
      look.kind,
      look.rule_version,
      look.variant,
      look.run_id,
      look.d,
    ],
  });
  stmts.push({
    sql: `INSERT OR IGNORE INTO pick_scorecard_run (id, market, created_at, commit_sha, sessions, first_d,
            last_d, status, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      run.id,
      run.market,
      run.createdAt,
      run.commitSha,
      run.sessions,
      run.firstD,
      run.lastD,
      run.status,
      JSON.stringify(run.summary),
    ],
  });
  for (let i = 0; i < stmts.length; i += BATCH) await db.batch(stmts.slice(i, i + BATCH), "write");
  return stmts.length;
}

/** The newest run of a market (one indexed read, no OFFSET); null when none or not readable. */
export async function loadLatestScorecard(
  db: Pick<Client, "execute">,
  market: string,
): Promise<ScorecardRun | null> {
  const r = await db.execute({
    sql: `SELECT id, market, created_at, commit_sha, sessions, first_d, last_d, status, summary_json
          FROM pick_scorecard_run WHERE market = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    args: [market],
  });
  const x = r.rows[0];
  if (x === undefined) return null;
  let summary: ScorecardSummary | null = null;
  try {
    summary = parseSummary(JSON.parse(String(x.summary_json)));
  } catch {
    summary = null;
  }
  if (summary === null) return null;
  return {
    id: String(x.id),
    market: String(x.market),
    createdAt: String(x.created_at),
    commitSha: String(x.commit_sha),
    sessions: Number(x.sessions),
    firstD: String(x.first_d),
    lastD: String(x.last_d),
    status: String(x.status) === "partial" ? "partial" : "complete",
    summary,
  };
}
