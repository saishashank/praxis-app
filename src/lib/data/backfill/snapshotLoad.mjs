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

/** D-202: rows per read. One read of the whole recent window (~490k bars) failed once the window
 * was seeded (D-199); pages keep every response small. */
export const PAGE_ROWS = 20_000; // threshold-ok: rows per database read

const num = (v) => (v === null ? null : Number(v));

/**
 * Load every table of the snapshot.
 * @param {{ db: import("@libsql/client").Client, readAsset: (name: string) => Uint8Array | null,
 *   from: string, to: string, recentFrom?: string, pageRows?: number }} o
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
  /** The rows of `sql` (which ends in a total ORDER BY) read page by page (D-202). */
  const qPaged = async (sql, args) => {
    const out = [];
    const pageRows = o.pageRows ?? PAGE_ROWS;
    for (let offset = 0; ; offset += pageRows) {
      const page = await q(`${sql} LIMIT ? OFFSET ?`, [...args, pageRows, offset]);
      out.push(...page);
      if (page.length < pageRows) return out;
    }
  };
  const barsRecent = (
    await qPaged(
      "SELECT code, d, o, h, l, c, volume FROM price_bar WHERE market = ? AND d >= ? AND d <= ? ORDER BY code, d",
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
    await qPaged(
      `SELECT code, ann_id, published_at, type, price_sensitive, title, first_ingested_at FROM announcement
       WHERE market = ? AND published_at >= ? AND published_at < ? ORDER BY id`,
      [MARKET, `${addDays(recentFrom, -1)}T00:00:00.000Z`, `${addDays(o.to, 2)}T00:00:00.000Z`],
    )
  ).map((r) => ({
    code: String(r.code),
    ann_id: String(r.ann_id),
    published_at: String(r.published_at),
    type: r.type === null ? null : String(r.type),
    price_sensitive: Number(r.price_sensitive),
    title: String(r.title),
    first_ingested_at: r.first_ingested_at === null ? null : String(r.first_ingested_at),
  }));
  // GL-05: the live cut-off poll markers of the range (worker_state cutoff_poll:AU:<d>)
  const cutoffPolls = (
    await q("SELECT key, value_json FROM worker_state WHERE key LIKE ? ORDER BY key", [
      `cutoff_poll:${MARKET}:%`,
    ])
  )
    .map((r) => {
      try {
        return {
          d: String(r.key).slice(`cutoff_poll:${MARKET}:`.length),
          at: JSON.parse(String(r.value_json)),
        };
      } catch {
        return null;
      }
    })
    .filter((m) => m !== null && typeof m.at === "string" && m.d >= o.from && m.d <= o.to);
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
  // DAT-234 / FAM-006: reference data known by the end of the range (manual CSV tables, migration 0018)
  const indexChanges = (
    await q(
      `SELECT code, index_name, kind, announced_d, effective_d, loaded_at FROM index_change
       WHERE market = ? AND COALESCE(announced_d, effective_d) <= ?
       ORDER BY code, index_name, kind, effective_d`,
      [MARKET, o.to],
    )
  ).map((r) => ({
    code: String(r.code),
    index_name: String(r.index_name),
    kind: String(r.kind),
    announced: r.announced_d === null ? null : String(r.announced_d),
    effective: String(r.effective_d),
    loaded_at: String(r.loaded_at),
  }));
  const industry = [
    ...(
      await q(
        "SELECT code, industry, as_of, loaded_at FROM instrument_class WHERE market = ? AND as_of <= ? ORDER BY code, as_of",
        [MARKET, o.to],
      )
    ).map((r) => ({
      code: String(r.code),
      industry: String(r.industry),
      source: "class",
      as_of: String(r.as_of),
      loaded_at: String(r.loaded_at),
    })),
    // the ASX industry group is the current one (no history is kept): dated at the range start
    ...(
      await q(
        "SELECT code, industry FROM instrument WHERE market = ? AND industry IS NOT NULL ORDER BY code",
        [MARKET],
      )
    ).map((r) => ({
      code: String(r.code),
      industry: String(r.industry),
      source: "instrument",
      as_of: o.from,
    })),
  ];
  const codes = (
    await q("SELECT DISTINCT code FROM corporate_action WHERE market = ?", [MARKET])
  ).map((r) => String(r.code));
  // D-204: the action type comes with the factors (it was one more query per factor)
  const actions = (await loadConfirmedFactors(o.db, codes)).map((f) => ({
    code: f.code,
    ex_date: f.exDate,
    action_id: f.actionId,
    type: f.type,
    factor: f.factor,
    known_at: f.knownAt ?? null,
  }));
  return {
    bars,
    bars_recent: barsRecent,
    announcements,
    announcements_recent: annRecent,
    cutoff_polls: cutoffPolls,
    calendar,
    universe,
    index_bars: index,
    corporate_actions: actions,
    index_changes: indexChanges,
    industry,
  };
}
