// State `picks-two-sections` (TST-135 (a), AT-62 (a)(b)): Picks and Home show "Tonight's picks" with one
// published pick and "Intraday watch" with a recorded scan, so both sections render from stored rows rather
// than only their empty states. Synthetic ZZ code; idempotent (every insert is keyed and ignored on repeat).
export const CODE = "ZZPS";
export const NAME = "ZZ Picks Section Ltd";
const SHA = "a".repeat(64);

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const d = nowIso.slice(0, 10);
  await client.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO instrument (market, code, name, listed_on, last_price, last_price_d)
              VALUES ('AU', ?, ?, '2020-01-02', 10, ?)`,
        args: [CODE, NAME, d],
      },
      {
        sql: `INSERT OR IGNORE INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
                reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm, typical_ppm,
                good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json, pick_sha, created_at)
              VALUES ('AU', ?, 'balanced', 1, ?, 'F1', 'U1', 'F1.v1', 'e2e-picks-signal', 'UNVALIDATED', 10000000,
                10050000, ?, 9200000, 11000000, 50, -60000, 20000, 110000, 10, 1000000000, 100000000, '[]', '[]', ?, ?)`,
        args: [d, CODE, d, SHA, nowIso],
      },
      {
        sql: `INSERT OR IGNORE INTO run_record (job, market, concurrency_key, started_at, ended_at, status, items_processed)
              VALUES ('intraday-scan', 'AU', ?, ?, ?, 'success', 1)`,
        args: [`e2e-state:picks-two-sections:${d}`, nowIso, nowIso],
      },
    ],
    "write",
  );
}
