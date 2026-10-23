// Loads the tables of a replay snapshot (M4 T4, DAT-140): history files for the old range, the
// database only for the recent window and the small tables. Read-only. Used by
// scripts/replay/snapshot.mjs; the pure builder is snapshotCore.mjs.
import { loadConfirmedFactors } from "./priceHistory.mjs";
import { JOB_ASX, MARKET, addDays, fromJsonlGz, monthOf } from "./rules.mjs";

/** About 500 sessions of calendar days (turso_recent_sessions). */
export const RECENT_DAYS = 730;
const PRICE_SOURCE = "yahoo_prices";

/** Every `yyyy-mm` between two dates, oldest first. */
export function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const last = monthOf(to);
  for (;;) {
    const key = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) return out;
    if (++m > 12) {
      m = 1;
      y += 1;
    }
  }
}

const num = (v) => (v === null ? null : Number(v));

/**
 * Load every table of the snapshot.
 * @param {{ db: import("@libsql/client").Client, readAsset: (name: string) => Uint8Array | null,
 *   from: string, to: string, recentFrom?: string }} o
 */
export async function loadInputs(o) {
  const cut = addDays(o.to, -RECENT_DAYS);
  const recentFrom = o.recentFrom ?? (cut > o.from ? cut : o.from);
  const bars = [];
  const announcements = [];
  for (const month of monthsBetween(o.from, o.to)) {
    const b = o.readAsset(`${PRICE_SOURCE}-${month}.jsonl.gz`);
    if (b) {
      for (const r of fromJsonlGz(b)) {
        bars.push({ code: r.code, d: r.d, o: r.o, h: r.h, l: r.l, c: r.c, volume: r.volume });
      }
    }
    const a = o.readAsset(`${JOB_ASX}-${month}.jsonl.gz`);
    if (a) {
      for (const r of fromJsonlGz(a)) {
        announcements.push({
          code: r.code,
          ann_id: r.ann_id,
          published_at: r.published_at,
          type: r.type,
          price_sensitive: r.price_sensitive,
          title: r.title,
        });
      }
    }
  }
  const q = async (sql, args) => (await o.db.execute({ sql, args })).rows;
  const barsRecent = (
    await q(
      "SELECT code, d, o, h, l, c, volume FROM price_bar WHERE market = ? AND d >= ? AND d <= ?",
      [MARKET, recentFrom, o.to],
    )
  ).map((r) => ({
    code: String(r.code),
    d: String(r.d),
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    volume: Number(r.volume),
  }));
  const annRecent = (
    await q(
      `SELECT code, ann_id, published_at, type, price_sensitive, title FROM announcement
       WHERE market = ? AND published_at >= ? AND published_at < ?`,
      [MARKET, `${addDays(recentFrom, -1)}T00:00:00.000Z`, `${addDays(o.to, 2)}T00:00:00.000Z`],
    )
  ).map((r) => ({
    code: String(r.code),
    ann_id: String(r.ann_id),
    published_at: String(r.published_at),
    type: r.type === null ? null : String(r.type),
    price_sensitive: Number(r.price_sensitive),
    title: String(r.title),
  }));
  const calendar = (
    await q(
      "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      [MARKET, o.from, o.to],
    )
  ).map((r) => ({
    d: String(r.d),
    kind: String(r.kind),
    close_time: r.close_time === null ? null : String(r.close_time),
    confirmed: Number(r.confirmed),
  }));
  const universe = (
    await q(
      "SELECT d, code, status, tier, mcap_est, adv, halted FROM universe_snapshot WHERE market = ? AND d >= ? AND d <= ?",
      [MARKET, o.from, o.to],
    )
  ).map((r) => ({
    d: String(r.d),
    code: String(r.code),
    status: String(r.status),
    tier: String(r.tier),
    mcap_est: num(r.mcap_est),
    adv: num(r.adv),
    halted: Number(r.halted),
  }));
  const index = (
    await q(
      // All index bars up to `to` (D-175): the regime warm-up lies before `from`; the table is
      // one row per session, so this is a few thousand rows.
      "SELECT index_code, d, o_micro, h_micro, l_micro, c_micro FROM index_bar WHERE market = ? AND d <= ?",
      [MARKET, o.to],
    )
  ).map((r) => ({
    index_code: String(r.index_code),
    d: String(r.d),
    o_micro: Number(r.o_micro),
    h_micro: Number(r.h_micro),
    l_micro: Number(r.l_micro),
    c_micro: Number(r.c_micro),
  }));
  const codes = (
    await q("SELECT DISTINCT code FROM corporate_action WHERE market = ?", [MARKET])
  ).map((r) => String(r.code));
  const actions = [];
  for (const f of await loadConfirmedFactors(o.db, codes)) {
    const t = await q("SELECT type FROM corporate_action WHERE id = ?", [f.actionId]);
    actions.push({
      code: f.code,
      ex_date: f.exDate,
      action_id: f.actionId,
      type: String(t[0].type),
      factor: f.factor,
    });
  }
  return {
    bars,
    bars_recent: barsRecent,
    announcements,
    announcements_recent: annRecent,
    calendar,
    universe,
    index_bars: index,
    corporate_actions: actions,
  };
}
