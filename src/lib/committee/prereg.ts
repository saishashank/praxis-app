// Committee trial pre-registration (M22 C2; VAL-111, D-1420, BLD-051). Before the first rated night a trial writes
// `committee_prereg` version 1: the frozen horizon, number of sessions, smallest settled sample, permutation count, the cost
// bar and the statistic's definition, with the sha of that exact text. A later version for the same trial, an unreadable
// frozen text or a sha that does not match marks the trial INVALID (the trial step writes that final row). One trial per
// market ever gets a verdict: once a verdict other than INVALID is on file (its holdout-look row exists) no new trial starts.
// Writes `committee_prereg` only; reads the keys, the look registry and the result rows.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import { roundTripThresholdPpm } from "@/lib/stats/committeeCost";
import type { Exec } from "./store";

export const TRIAL_LINEAGE = "committee_trial";
export const STATISTIC_TEXT =
  "D = the mean outcome of the approved signals minus the mean outcome of the rejected ones; the null comes from " +
  "label permutations within each night; one-sided p below 0.05";
const P_LEVEL_PPM = 50_000; // threshold-ok: VAL-111 one-sided p below 0.05, in ppm
/** The smallest judge-model segment that can veto a PASS with a sign reversal (D-1421). */
export const SEGMENT_MIN = 50; // threshold-ok: VAL-111 segment of at least 50 settled signals

/** What a pre-registration freezes (D-1420). */
export type Frozen = {
  market: string;
  started_d: string;
  horizon_sessions: number;
  trial_sessions: number;
  min_settled: number;
  permutations: number;
  /** One round trip at the default cost profile, ppm of the notional (D-1421). */
  cost_threshold_ppm: number;
  p_level_ppm: number;
  segment_min: number;
  statistic: string;
};

const INT_FIELDS = [
  "horizon_sessions",
  "trial_sessions",
  "min_settled",
  "permutations",
  "cost_threshold_ppm",
  "p_level_ppm",
  "segment_min",
] as const;

/** The frozen text as stored: fixed key order, so the same figures always give the same sha. */
export function frozenText(f: Frozen): string {
  return JSON.stringify({
    market: f.market,
    started_d: f.started_d,
    horizon_sessions: f.horizon_sessions,
    trial_sessions: f.trial_sessions,
    min_settled: f.min_settled,
    permutations: f.permutations,
    cost_threshold_ppm: f.cost_threshold_ppm,
    p_level_ppm: f.p_level_ppm,
    segment_min: f.segment_min,
    statistic: f.statistic,
  });
}

export const shaOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The figures of a stored frozen text, or null when it is not a complete pre-registration. */
export function parseFrozen(text: string): Frozen | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    if (typeof v.market !== "string" || typeof v.started_d !== "string") return null;
    if (typeof v.statistic !== "string") return null;
    for (const k of INT_FIELDS) {
      const n = v[k];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    }
    return v as unknown as Frozen;
  } catch {
    return null;
  }
}

export type PreregRow = {
  trialId: string;
  version: number;
  frozenJson: string;
  sha: string;
  createdAt: string;
};

/** Every version of one trial's pre-registration, oldest first. */
export async function readVersions(
  db: Exec,
  market: string,
  trialId: string,
): Promise<PreregRow[]> {
  // rows-ok: committee_prereg primary key (trial_id, version) prefix, a few versions, LIMIT 20
  const r = await db.execute({
    sql: `SELECT trial_id, version, frozen_json, sha, created_at FROM committee_prereg
           WHERE trial_id = ? AND market = ? ORDER BY version LIMIT 20`,
    args: [trialId, market],
  });
  return r.rows.map((x) => ({
    trialId: String(x.trial_id),
    version: Number(x.version),
    frozenJson: String(x.frozen_json),
    sha: String(x.sha),
    createdAt: String(x.created_at),
  }));
}

/** Null when the stored pre-registration is sound (one version, readable, sha matching), else the reason in words. */
export function preregProblem(rows: readonly PreregRow[]): string | null {
  const first = rows[0];
  if (first === undefined) return "no pre-registration";
  if (rows.length > 1) return "the pre-registration was edited after the trial started";
  if (parseFrozen(first.frozenJson) === null) return "the pre-registration cannot be read";
  if (shaOf(first.frozenJson) !== first.sha)
    return "the pre-registration no longer matches its fingerprint";
  return null;
}

async function lookTaken(db: Exec, market: string): Promise<boolean> {
  // rows-ok: holdout_look primary key (lineage, market), one row
  const r = await db.execute({
    sql: "SELECT 1 FROM holdout_look WHERE lineage = ? AND market = ? LIMIT 1",
    args: [TRIAL_LINEAGE, market],
  });
  return r.rows.length > 0;
}

export type PreregResult =
  | { status: "written"; trialId: string; sha: string }
  | { status: "present"; trialId: string }
  | { status: "done" }
  | { status: "off" | "refused" };

/**
 * Writes version 1 for a new trial when the switch is on and no trial is running (D-1420). Call it before the Committee
 * night, so the engine finds the trial. Forward only: a replay or a day other than today is refused. Nothing is written
 * when a verdict other than INVALID is on file (one look per market), or a trial is still running.
 */
export async function ensurePrereg(
  db: Client,
  o: { market: string; d: string; today: string; replay?: boolean; now: string },
): Promise<PreregResult> {
  if (o.replay === true || o.d !== o.today) return { status: "refused" };
  if ((await getConfig(db, "committee_enabled")) !== "on") return { status: "off" };
  // rows-ok: committee_prereg newest trial of one market, LIMIT 1; the final probe is a primary-key prefix, LIMIT 1
  const newest = await db.execute({
    sql: `SELECT p.trial_id AS trial_id,
                 (SELECT f.verdict FROM committee_trial_result f
                   WHERE f.trial_id = p.trial_id AND f.market = p.market AND f.kind = 'final' LIMIT 1) AS verdict
            FROM committee_prereg p WHERE p.market = ?
           ORDER BY p.created_at DESC, p.version DESC LIMIT 1`,
    args: [o.market],
  });
  const row = newest.rows[0];
  if (row !== undefined) {
    const verdict = row.verdict === null || row.verdict === undefined ? null : String(row.verdict);
    if (verdict === null) return { status: "present", trialId: String(row.trial_id) };
    if (verdict !== "INVALID") return { status: "done" };
  }
  if (await lookTaken(db, o.market)) return { status: "done" };
  const frozen: Frozen = {
    market: o.market,
    started_d: o.d,
    horizon_sessions: Number(await getConfig(db, "committee_horizon_sessions")),
    trial_sessions: Number(await getConfig(db, "committee_trial_sessions")),
    min_settled: Number(await getConfig(db, "committee_min_settled")),
    permutations: Number(await getConfig(db, "committee_permutations")),
    cost_threshold_ppm: roundTripThresholdPpm(),
    p_level_ppm: P_LEVEL_PPM,
    segment_min: SEGMENT_MIN,
    statistic: STATISTIC_TEXT,
  };
  const text = frozenText(frozen);
  const sha = shaOf(text);
  const trialId = `committee-${o.d}`;
  // rows-ok: one keyed insert, once per trial
  const w = await db.execute({
    sql: `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at)
          VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [trialId, o.market, text, sha, o.now],
  });
  return w.rowsAffected > 0 ? { status: "written", trialId, sha } : { status: "present", trialId };
}
