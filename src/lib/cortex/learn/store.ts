// The learning Cortex's tables (migration 0031; design C.6, C.7 "store.ts"). Every writer is batched
// insert-or-ignore (200 statements per db.batch), so a re-run of a night writes nothing new; every
// reader scans a primary-key prefix by date range (market, d...) and never pages with OFFSET (Turso
// free plan, D-903/D-904).
import type { InStatement } from "@libsql/client";
import {
  jsonText,
  num,
  numOrNull,
  parseJson,
  str,
  strOrNull,
  type BatchExec,
  type Exec,
} from "../store/common";
import type { AngleDayRow, FeatureNight, Horizon } from "./scorecard";

/** Statements per db.batch. */
export const LEARN_BATCH = 200; // threshold-ok: statements per batched write (C.7)

async function batchedIgnore(db: BatchExec, stmts: readonly InStatement[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += LEARN_BATCH) {
    const res = await db.batch(stmts.slice(i, i + LEARN_BATCH), "write");
    inserted += res.reduce((n, x) => n + x.rowsAffected, 0);
  }
  return inserted;
}

const upper = (toD: string | undefined): string => toD ?? "9999-12-31";

// ---- cortex_angle_day ------------------------------------------------------------------------------

export async function insertAngleDays(
  db: BatchExec,
  rows: readonly AngleDayRow[],
): Promise<{ inserted: number }> {
  const stmts = rows.map((r): InStatement => ({
    sql: `INSERT INTO cortex_angle_day (market, d, angle_id, angle_version, horizon, feature_d, n, ic,
              top_excess_ppm, bottom_excess_ppm, base_ppm, regime, results_season, psi_ppm, excluded_news,
              active_set_hash, manifest_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
    args: [
      r.market,
      r.d,
      r.angleId,
      r.angleVersion,
      r.horizon,
      r.featureD,
      r.n,
      r.ic,
      r.topExcessPpm,
      r.bottomExcessPpm,
      r.basePpm,
      r.regime,
      r.resultsSeason,
      r.psiPpm,
      r.excludedNews,
      r.activeSetHash,
      r.manifestId,
    ],
  }));
  return { inserted: await batchedIgnore(db, stmts) };
}

const toAngleDay = (x: Record<string, unknown>): AngleDayRow => ({
  market: str(x.market),
  d: str(x.d),
  angleId: str(x.angle_id),
  angleVersion: num(x.angle_version),
  horizon: num(x.horizon) as Horizon,
  featureD: str(x.feature_d),
  n: num(x.n),
  ic: numOrNull(x.ic),
  topExcessPpm: numOrNull(x.top_excess_ppm),
  bottomExcessPpm: numOrNull(x.bottom_excess_ppm),
  basePpm: numOrNull(x.base_ppm),
  regime: str(x.regime),
  resultsSeason: num(x.results_season) === 1 ? 1 : 0,
  psiPpm: numOrNull(x.psi_ppm),
  excludedNews: num(x.excluded_news),
  activeSetHash: str(x.active_set_hash),
  manifestId: str(x.manifest_id),
});

/** Scorecard rows of nights fromD..toD (inclusive), oldest first, by angle and horizon. */
export async function angleDaysSince(
  db: Exec,
  market: string,
  fromD: string,
  toD?: string,
): Promise<AngleDayRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_angle_day WHERE market = ? AND d >= ? AND d <= ?
          ORDER BY d, angle_id, horizon`,
    args: [market, fromD, upper(toD)],
  });
  return r.rows.map((x) => toAngleDay(x as Record<string, unknown>));
}

// ---- cortex_learn_compare --------------------------------------------------------------------------

export type CompareRow = {
  readonly market: string;
  readonly decisionD: string;
  readonly family: string;
  readonly bookId: string;
  readonly fixedRuleVersion: string;
  readonly learnerRuleVersion: string;
  readonly learnerGeneration: number;
  readonly fixedCode: string | null;
  readonly learnerCode: string | null;
  readonly agree: 0 | 1;
  readonly fixedRet1Ppm: number | null;
  readonly learnerRet1Ppm: number | null;
  readonly fixedRet20Ppm: number | null;
  readonly learnerRet20Ppm: number | null;
  readonly maturedD: string;
  readonly regime: string;
};

export async function insertCompareRows(
  db: BatchExec,
  rows: readonly CompareRow[],
): Promise<{ inserted: number }> {
  const stmts = rows.map((r): InStatement => ({
    sql: `INSERT INTO cortex_learn_compare (market, decision_d, family, book_id, fixed_rule_version,
              learner_rule_version, learner_generation, fixed_code, learner_code, agree, fixed_ret1_ppm,
              learner_ret1_ppm, fixed_ret20_ppm, learner_ret20_ppm, matured_d, regime)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      r.market,
      r.decisionD,
      r.family,
      r.bookId,
      r.fixedRuleVersion,
      r.learnerRuleVersion,
      r.learnerGeneration,
      r.fixedCode,
      r.learnerCode,
      r.agree,
      r.fixedRet1Ppm,
      r.learnerRet1Ppm,
      r.fixedRet20Ppm,
      r.learnerRet20Ppm,
      r.maturedD,
      r.regime,
    ],
  }));
  return { inserted: await batchedIgnore(db, stmts) };
}

/** Comparison rows of decision nights fromD..toD (inclusive), oldest first. */
export async function compareRowsSince(
  db: Exec,
  market: string,
  fromD: string,
  toD?: string,
): Promise<CompareRow[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_learn_compare WHERE market = ? AND decision_d >= ? AND decision_d <= ?
          ORDER BY decision_d, family, book_id`,
    args: [market, fromD, upper(toD)],
  });
  return r.rows.map((row) => {
    const x = row as Record<string, unknown>;
    return {
      market: str(x.market),
      decisionD: str(x.decision_d),
      family: str(x.family),
      bookId: str(x.book_id),
      fixedRuleVersion: str(x.fixed_rule_version),
      learnerRuleVersion: str(x.learner_rule_version),
      learnerGeneration: num(x.learner_generation),
      fixedCode: strOrNull(x.fixed_code),
      learnerCode: strOrNull(x.learner_code),
      agree: num(x.agree) === 1 ? 1 : 0,
      fixedRet1Ppm: numOrNull(x.fixed_ret1_ppm),
      learnerRet1Ppm: numOrNull(x.learner_ret1_ppm),
      fixedRet20Ppm: numOrNull(x.fixed_ret20_ppm),
      learnerRet20Ppm: numOrNull(x.learner_ret20_ppm),
      maturedD: str(x.matured_d),
      regime: str(x.regime),
    };
  });
}

// ---- cortex_learn_event ----------------------------------------------------------------------------

export type LearnEventKind =
  | "scorecard"
  | "checkpoint"
  | "watch"
  | "cap"
  | "escalate"
  | "reweight"
  | "no_change"
  | "bench"
  | "unbench"
  | "probe_open"
  | "probe_close"
  | "platt_refit"
  | "switch"
  | "fallback"
  | "rollback"
  | "placebo"
  | "base_change";

export type LearnEvent = {
  readonly market: string;
  readonly d: string;
  readonly seq: number;
  readonly kind: LearnEventKind;
  readonly family?: string | null;
  readonly angleId?: string | null;
  readonly generation?: number | null;
  readonly evidence: unknown;
  readonly words: string;
  readonly reversesSeq?: number | null;
  readonly expiresD?: string | null;
  readonly createdAt: string;
};

/** Logs one action (insert-or-ignore by (market, d, seq)); false = it was already logged. */
export async function logEvent(db: Exec, e: LearnEvent): Promise<{ inserted: boolean }> {
  const r = await db.execute({
    sql: `INSERT INTO cortex_learn_event (market, d, seq, kind, family, angle_id, generation, evidence_json,
            words, reverses_seq, expires_d, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    args: [
      e.market,
      e.d,
      e.seq,
      e.kind,
      e.family ?? null,
      e.angleId ?? null,
      e.generation ?? null,
      jsonText(e.evidence),
      e.words,
      e.reversesSeq ?? null,
      e.expiresD ?? null,
      e.createdAt,
    ],
  });
  return { inserted: r.rowsAffected > 0 };
}

/** Events of nights fromD..toD (inclusive), oldest first. */
export async function eventsSince(
  db: Exec,
  market: string,
  fromD: string,
  toD?: string,
): Promise<LearnEvent[]> {
  const r = await db.execute({
    sql: `SELECT * FROM cortex_learn_event WHERE market = ? AND d >= ? AND d <= ? ORDER BY d, seq`,
    args: [market, fromD, upper(toD)],
  });
  return r.rows.map((row) => {
    const x = row as Record<string, unknown>;
    return {
      market: str(x.market),
      d: str(x.d),
      seq: num(x.seq),
      kind: str(x.kind) as LearnEventKind,
      family: strOrNull(x.family),
      angleId: strOrNull(x.angle_id),
      generation: numOrNull(x.generation),
      evidence: parseJson(x.evidence_json),
      words: str(x.words),
      reversesSeq: numOrNull(x.reverses_seq),
      expiresD: strOrNull(x.expires_d),
      createdAt: str(x.created_at),
    };
  });
}

// ---- cortex_leader ---------------------------------------------------------------------------------

export type LeaderRow = {
  readonly market: string;
  readonly family: string;
  readonly sinceD: string;
  readonly leader: "fixed" | "learner";
  readonly learnerRuleVersion: string | null;
  readonly learnerGeneration: number | null;
  readonly evidence: unknown;
  readonly setBy: "evaluator" | "fallback" | "owner_kill";
};

export async function insertLeader(db: Exec, row: LeaderRow): Promise<{ inserted: boolean }> {
  const r = await db.execute({
    sql: `INSERT INTO cortex_leader (market, family, since_d, leader, learner_rule_version,
            learner_generation, evidence_json, set_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      row.market,
      row.family,
      row.sinceD,
      row.leader,
      row.learnerRuleVersion,
      row.learnerGeneration,
      jsonText(row.evidence),
      row.setBy,
    ],
  });
  return { inserted: r.rowsAffected > 0 };
}

/** The leader of each family as of session d (the latest since_d <= d); a family without a row has
 *  none here and is led by its fixed rule. */
export async function leaderMap(
  db: Exec,
  market: string,
  d: string,
): Promise<Map<string, LeaderRow>> {
  const r = await db.execute({
    sql: `SELECT l.* FROM cortex_leader l
          JOIN (SELECT family, MAX(since_d) AS since_d FROM cortex_leader
                WHERE market = ? AND since_d <= ? GROUP BY family) m
            ON m.family = l.family AND m.since_d = l.since_d
          WHERE l.market = ? ORDER BY l.family`,
    args: [market, d, market],
  });
  const out = new Map<string, LeaderRow>();
  for (const row of r.rows) {
    const x = row as Record<string, unknown>;
    out.set(str(x.family), {
      market: str(x.market),
      family: str(x.family),
      sinceD: str(x.since_d),
      leader: str(x.leader) === "learner" ? "learner" : "fixed",
      learnerRuleVersion: strOrNull(x.learner_rule_version),
      learnerGeneration: numOrNull(x.learner_generation),
      evidence: parseJson(x.evidence_json),
      setBy: str(x.set_by) as LeaderRow["setBy"],
    });
  }
  return out;
}

// ---- cortex_feature_daily (read only) --------------------------------------------------------------

/** The stored feature nights of the given sessions, one batched read (2 nights ≈ 5,000 rows). */
export async function featureNights(
  db: BatchExec,
  market: string,
  ds: readonly string[],
): Promise<Map<string, FeatureNight>> {
  const out = new Map<string, FeatureNight>();
  if (ds.length === 0) return out;
  const res = await db.batch(
    ds.map((d) => ({
      sql: `SELECT code, features_json, active_set_hash, manifest_id FROM cortex_feature_daily
            WHERE market = ? AND d = ? ORDER BY code`,
      args: [market, d],
    })),
    "read",
  );
  ds.forEach((d, i) => {
    out.set(d, {
      d,
      rows: res[i]!.rows.map((x) => ({
        code: str(x.code),
        features: parseJson<Record<string, unknown>>(x.features_json),
        activeSetHash: str(x.active_set_hash),
        manifestId: str(x.manifest_id),
      })),
    });
  });
  return out;
}
