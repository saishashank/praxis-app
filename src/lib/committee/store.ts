// Committee storage (M22 C1; AGT-145, LLM-066; D-1419, D-1444). Typed inserts and reads for the two tables the engine
// writes (`committee_rating`, `committee_call`) and the read-only look at the trial rows C2 owns. Every function takes
// `Exec` only (one `execute`). Ratings and calls are append-only; an insert is idempotent by primary key
// (`inserted: false` = already there). Nothing here can reach an order, a breaker, a rule or a pick (PRD-033).
import type { Exec, WriteResult } from "@/lib/cortex/store/common";
import { num, str } from "@/lib/cortex/store/common";

export type { Exec, WriteResult };

export type Rating =
  | "approve"
  | "neutral"
  | "reject"
  | "skipped_budget"
  | "skipped_time"
  | "skipped_models"
  | "failed";

export type Stage = "bull" | "bear" | "risk" | "judge";

export type RatingRow = {
  market: string;
  d: string;
  signalId: string;
  trialId: string;
  packId: string;
  rating: Rating;
  /** Already serialised: a JSON array of at most five reasons, at most 2,000 characters. */
  reasonsJson: string;
  bullModel: string | null;
  bearModel: string | null;
  riskModel: string | null;
  judgeModel: string | null;
  sameFamily: boolean;
  timingsJson: string;
  createdAt: string;
};

export type CallRow = {
  /** The id of the router's call-log row. */
  id: string;
  market: string;
  d: string;
  signalId: string;
  stage: Stage;
  promptSha: string;
  packId: string;
  provider: string;
  modelId: string;
  modelVersion: string;
  paramsJson: string;
  /** At most 8,000 characters (the table's CHECK); longer text is cut by `capRaw`. */
  rawResponse: string;
  parsedJson: string | null;
  createdAt: string;
  expiresD: string;
};

export const RAW_MAX = 8000; // threshold-ok: committee_call.raw_response CHECK (D-1419)
export const PARSED_MAX = 8000; // threshold-ok: committee_call.parsed_json CHECK

/** The raw answer cut to the table's limit. */
export const capRaw = (s: string): string => (s.length <= RAW_MAX ? s : s.slice(0, RAW_MAX));

const inserted = (r: { rowsAffected: number }): WriteResult => ({ inserted: r.rowsAffected > 0 });

export async function insertRating(db: Exec, r: RatingRow): Promise<WriteResult> {
  // rows-ok: one keyed insert per shortlisted signal of the night (at most committee_shortlist, 5)
  return inserted(
    await db.execute({
      sql: `INSERT INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json,
              bull_model, bear_model, risk_model, judge_model, same_family, timings_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        r.market,
        r.d,
        r.signalId,
        r.trialId,
        r.packId,
        r.rating,
        r.reasonsJson,
        r.bullModel,
        r.bearModel,
        r.riskModel,
        r.judgeModel,
        r.sameFamily ? 1 : 0,
        r.timingsJson,
        r.createdAt,
      ],
    }),
  );
}

export async function insertCall(db: Exec, c: CallRow): Promise<WriteResult> {
  // rows-ok: one keyed insert per model call (at most four per shortlisted signal, about 12 a night)
  return inserted(
    await db.execute({
      sql: `INSERT INTO committee_call (id, market, d, signal_id, stage, prompt_sha, pack_id, provider,
              model_id, model_version, params_json, raw_response, parsed_json, created_at, expires_d)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        c.id,
        c.market,
        c.d,
        c.signalId,
        c.stage,
        c.promptSha,
        c.packId,
        c.provider,
        c.modelId,
        c.modelVersion,
        c.paramsJson,
        capRaw(c.rawResponse),
        c.parsedJson,
        c.createdAt,
        c.expiresD,
      ],
    }),
  );
}

/** The signals of a night that already have a rating (a resumed run skips them). */
export async function ratedSignalIds(db: Exec, market: string, d: string): Promise<Set<string>> {
  // rows-ok: committee_rating primary key (market, d, signal_id) prefix; at most committee_shortlist (5) rows
  const r = await db.execute({
    sql: "SELECT signal_id FROM committee_rating WHERE market = ? AND d = ? LIMIT 50",
    args: [market, d],
  });
  return new Set(r.rows.map((x) => str(x.signal_id)));
}

export type TrialRef = { trialId: string; version: number; finished: boolean };

/**
 * The newest pre-registration of the market (C2 writes it, D-1420) and whether its final verdict is on file; null when
 * there is none (a failed read throws: the night then reports `failed`). The engine rates nothing without a pre-registration (VAL-111).
 */
export async function readTrial(db: Exec, market: string): Promise<TrialRef | null> {
  // rows-ok: committee_prereg primary key (trial_id, version) scanned for one market, newest first, LIMIT 1
  const p = await db.execute({
    sql: `SELECT trial_id, version FROM committee_prereg WHERE market = ?
          ORDER BY created_at DESC, version DESC LIMIT 1`,
    args: [market],
  });
  const row = p.rows[0];
  if (!row) return null;
  // rows-ok: committee_trial_result primary key (trial_id, market, d, kind) prefix, LIMIT 1
  const f = await db.execute({
    sql: `SELECT 1 AS n FROM committee_trial_result WHERE trial_id = ? AND market = ? AND kind = 'final' LIMIT 1`,
    args: [str(row.trial_id), market],
  });
  return { trialId: str(row.trial_id), version: num(row.version), finished: f.rows.length > 0 };
}
