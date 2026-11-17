// State `committee-trial` (M22 A1, D-1444, D-1423; AT-76): the Committee is switched on and holds a pre-registered trial with
// three nights of ratings and their interim rows, so the trial page (M22) renders from stored rows. Sets `committee_enabled`
// = "on" (the only place outside a test database that does; the key is "off" in every fresh configuration), one
// `committee_prereg` row (version 1, with the sha of its frozen text), three AU nights of three ratings each and one interim
// `committee_trial_result` per night ("running": interim, not a result). Outcomes are not stored here: they are read from the
// ledger (D-1422). Synthetic ZZ signal ids, fixed names, idempotent: each insert is guarded by a NOT EXISTS or is keyed.
import { createHash } from "node:crypto";
import { tradingDays } from "../data.mjs";

export const TRIAL_ID = "zz-e2e-trial-1";
/** The frozen pre-registration text (D-1420): horizon, sessions, minimum settled, permutations, cost threshold. */
export const FROZEN = {
  horizon_sessions: 5,
  trial_sessions: 20,
  min_settled: 60,
  permutations: 2000,
  cost_threshold: "one_round_trip",
  statistic: "mean approve outcome minus mean reject outcome",
};
export const FROZEN_JSON = JSON.stringify(FROZEN);
export const FROZEN_SHA = createHash("sha256").update(FROZEN_JSON).digest("hex");
export const RATINGS = ["approve", "neutral", "reject"];

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const days = tradingDays(nowIso, 3);
  /** @type {{ sql: string, args: (string | number | null)[] }[]} */
  const stmts = [
    {
      sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
            SELECT 'committee_enabled', 'global', '"on"', '"off"', NULL, ?, 'e2e seed state committee-trial'
            WHERE NOT EXISTS (SELECT 1 FROM config_version WHERE key = 'committee_enabled' AND scope = 'global')`,
      args: [nowIso],
    },
    {
      sql: `INSERT OR IGNORE INTO committee_prereg (trial_id, version, market, frozen_json, sha, created_at)
            VALUES (?, 1, 'AU', ?, ?, ?)`,
      args: [TRIAL_ID, FROZEN_JSON, FROZEN_SHA, nowIso],
    },
  ];
  for (const d of days) {
    RATINGS.forEach((rating, i) => {
      stmts.push({
        sql: `INSERT OR IGNORE INTO committee_rating (market, d, signal_id, trial_id, pack_id, rating, reasons_json,
                bull_model, bear_model, risk_model, judge_model, same_family, timings_json, created_at)
              VALUES ('AU', ?, ?, ?, ?, ?, '["ZZ fixture reason"]', 'zz-bull', 'zz-bear', 'zz-bull', 'zz-judge', 0,
                '{"total_ms":1}', ?)`,
        args: [d, `ZZ-SIG-${i + 1}`, TRIAL_ID, `zz-pack-${d}-${i + 1}`, rating, nowIso],
      });
    });
    stmts.push({
      sql: `INSERT OR IGNORE INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at)
            VALUES (?, 'AU', ?, 'interim', 'running', '{"settled":0,"note":"interim, not a result"}', ?)`,
      args: [TRIAL_ID, d, nowIso],
    });
  }
  await client.batch(stmts, "write");
}
