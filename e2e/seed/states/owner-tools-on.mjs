// State `owner-tools-on` (M21 A1, D-1236, D-1214; AT-77): the Owner tools are switched on and hold one row each, so
// /recommendations, /holdings and /trades render from stored rows. Sets `owner_real_money_tools` = "on" (the only
// place outside a test database that does; the key is "off" in every fresh configuration), one AU `owner_trade` and one
// `owner_holding` upload. Synthetic ZZ code, fixed names, idempotent: each insert is guarded by a NOT EXISTS or is keyed.
import { tradingDays } from "../data.mjs";

export const CODE = "ZZOT";
export const NAME = "ZZ Owner Tools Ltd";
export const UPLOAD_ID = "e2e-upload-1";
export const ACTOR = "e2e-owner";

/** @param {import("@libsql/client").Client} client @param {string} nowIso */
export async function apply(client, nowIso) {
  const d = tradingDays(nowIso, 1)[0];
  await client.batch(
    [
      {
        sql: `INSERT OR IGNORE INTO instrument (market, code, name, listed_on, last_price, last_price_d)
              VALUES ('AU', ?, ?, '2020-01-02', 10, ?)`,
        args: [CODE, NAME, d],
      },
      {
        sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
              SELECT 'owner_real_money_tools', 'global', '"on"', '"off"', NULL, ?, 'e2e seed state owner-tools-on'
              WHERE NOT EXISTS (SELECT 1 FROM config_version WHERE key = 'owner_real_money_tools' AND scope = 'global')`,
        args: [nowIso],
      },
      {
        sql: `INSERT INTO owner_trade (market, code, side, d, qty, price_micro, fees_micro, note, source, upload_id, entered_at, entered_by)
              SELECT 'AU', ?, 'buy', ?, 100, 10000000, 1000000, NULL, 'typed', NULL, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM owner_trade WHERE entered_by = ?)`,
        args: [CODE, d, nowIso, ACTOR, ACTOR],
      },
      {
        sql: `INSERT OR IGNORE INTO owner_holding (upload_id, market, code, qty, avg_cost_micro, uploaded_at)
              VALUES (?, 'AU', ?, 100, 10000000, ?)`,
        args: [UPLOAD_ID, CODE, nowIso],
      },
    ],
    "write",
  );
}
