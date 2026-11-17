// Test-only helper for the Committee trial tests (M22 C2): a trial world over the real migrations. Synthetic ZZ data only.
// `build` writes the pre-registration, and per rated signal one `signal` row, one `committee_rating` row and (when the
// outcome is given) one closed forward `ledger_row` whose net result is exactly the requested ppm of its cost basis.
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { setConfig } from "@/lib/config/store";
import { frozenText, shaOf, type Frozen } from "@/lib/committee/prereg";
import { freshDb } from "../db/helpers";

export const TRIAL = "zz-trial-1";
export const START = "2026-01-05"; // a Monday
export const NOW = "2026-06-30T08:00:00.000Z";

export const FROZEN: Frozen = {
  market: "AU",
  started_d: START,
  horizon_sessions: 5,
  trial_sessions: 6,
  min_settled: 12,
  permutations: 2000,
  cost_threshold_ppm: 1000,
  p_level_ppm: 50_000,
  segment_min: 50,
  statistic: "zz statistic",
};

export type Spec = {
  /** Night index, 0 = START. */
  night: number;
  rating: "approve" | "neutral" | "reject" | "skipped_models" | "skipped_budget" | "failed";
  /** The ledger net in ppm; null = no ledger row (unsettled); a number = closed within the horizon. */
  net: number | null;
  judge?: string;
  /** Close this many calendar days after the entry instead of one (to test the horizon). */
  exitDays?: number;
  /** An open ledger row (no exit). */
  open?: boolean;
};

export const dayOf = (i: number): string => addDays(START, i);

export async function switchOn(db: Client): Promise<void> {
  await setConfig(db, {
    key: "committee_enabled",
    value: "on",
    userId: null,
    reason: "zz",
    now: NOW,
  });
}

export async function build(
  specs: readonly Spec[],
  o: { frozen?: Partial<Frozen>; trialId?: string; prereg?: boolean; db?: Client } = {},
): Promise<Client> {
  const db = o.db ?? (await freshDb("main"));
  const trialId = o.trialId ?? TRIAL;
  if (o.prereg !== false) {
    const text = frozenText({ ...FROZEN, ...o.frozen });
    await db.execute({
      sql: `INSERT INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at)
            VALUES (?, 1, 'AU', ?, ?, ?)`,
      args: [trialId, text, shaOf(text), "2026-01-05T00:00:00.000Z"],
    });
  }
  const perNight = new Map<number, number>();
  for (const s of specs) {
    const k = (perNight.get(s.night) ?? 0) + 1;
    perNight.set(s.night, k);
    const d = dayOf(s.night);
    const id = `ZZ-${trialId}-${d}-${k}`;
    await db.execute({
      sql: `INSERT INTO signal (id, market, d, family, rule_version, variant, code, regime, rank_score, rules_json,
              evidence_json, schema_version, agent_version, inputs_ref, decided_at)
            VALUES (?, 'AU', ?, 'F3', 'v1', 'base', ?, 'NEUTRAL', '1', '[]', '{}', 1, 'a', 'r', ?)`,
      args: [id, d, `ZZ${s.night}X${k}`, `${d}T07:00:00.000Z`],
    });
    await db.execute({
      sql: `INSERT INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json, bull_model,
              bear_model, risk_model, judge_model, same_family, timings_json, created_at)
            VALUES ('AU', ?, ?, ?, ?, ?, '[]', 'zz-bull', 'zz-bear', 'zz-bull', ?, 0, '{}', ?)`,
      args: [
        d,
        id,
        trialId,
        `zz-pack-${id}`,
        s.rating,
        s.judge ?? "zz-judge",
        `${d}T08:00:00.000Z`,
      ],
    });
    if (s.net === null && s.open !== true) continue;
    const entry = addDays(d, 1);
    await db.execute({
      sql: `INSERT INTO ledger_row (id, signal_id, entry_d, qty, fill_in_micro, brok_in_micro, stress_in_micro, timed, forward)
            VALUES (?, ?, ?, 1, 1000000, 0, 1000000, 0, 1)`,
      args: [`L-${id}`, id, entry],
    });
    if (s.open === true || s.net === null) continue;
    await db.execute({
      sql: `UPDATE ledger_row SET exit_d = ?, exit_tag = 'CS', fill_out_micro = ?, brok_out_micro = 0,
              stress_out_micro = ?, qty_out = 1, gross_num = ?, gross_den = 1000000 WHERE id = ?`,
      args: [
        addDays(entry, s.exitDays ?? 1),
        1_000_000 + s.net,
        1_000_000 + s.net,
        s.net,
        `L-${id}`,
      ],
    });
  }
  return db;
}

/** `nights` nights of the three labels with outcomes from `outcome(night, label)`. */
export function grid(
  nights: number,
  outcome: (night: number, label: "approve" | "neutral" | "reject") => number,
  judge: (night: number) => string = () => "zz-judge",
): Spec[] {
  const out: Spec[] = [];
  for (let n = 0; n < nights; n++)
    for (const rating of ["approve", "neutral", "reject"] as const)
      out.push({ night: n, rating, net: outcome(n, rating), judge: judge(n) });
  return out;
}
