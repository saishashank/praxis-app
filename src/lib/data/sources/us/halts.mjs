// Trading halts and suspensions -> `trading_halt` (M20 US1; DAT-243, CTX-016, D-1110, D-1162, D-1185). Two feeds:
//   - the Nasdaq trade-halt RSS (one `<item>` per halt: halt date and time in exchange local time, the symbol, the reason
//     code, the resumption date and time when known). Volatility pauses (LUDP, LUDS) and the single-stock pause
//     (T5) are `luld`; the SEC trading suspension (H10) is `suspension`; every other single-issue reason is `halt`;
//     a market-wide circuit breaker (MWC*) names no issue and is skipped;
//   - the SEC trading-suspension feed (RSS): one `suspension` per item, the ticker taken from the text when it carries
//     one (`Ticker: XYZ` or a `(XYZ)` tag), otherwise skipped and counted. A suspension has no resumption instant in
//     the feed, so `resumed_at` stays NULL until a later run sets it (the table allows that one update).
// Times are converted from the exchange zone (passed in: the profile's `tz`) to UTC instants. Nothing here is a fill
// rule: the models in `cortex/states/luld.ts` read the rows. Pure parsing, plus one writer behind `assertMarketEnabled`.
import { assertMarketEnabled } from "../../../market/guard.mjs";

export const NASDAQ_HALTS_SOURCE = "us_nasdaq_halts";
export const SEC_SUSPENSIONS_SOURCE = "us_sec_suspensions";
const LULD_REASONS = new Set(["LUDP", "LUDS", "T5"]);

/** Offset (ms) of `tz` at the UTC instant `ms`: local wall clock minus UTC. @param {number} ms @param {string} tz */
function offsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant (ISO) of a local date and time in `tz`; `time` is `HH:MM:SS` with optional fraction. A time inside
 * a spring-forward gap resolves forward; an ambiguous autumn time resolves to the first occurrence.
 * @param {string} date YYYY-MM-DD @param {string} time @param {string} tz
 */
export function zonedToUtc(date, time, tz) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(time.trim());
  if (!dm || !tm) throw new RangeError("bad local date or time");
  const ms = tm[4] === undefined ? 0 : Math.round(Number(`0.${tm[4]}`) * 1000);
  const wall = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], +(tm[3] ?? 0), ms);
  let utc = wall - offsetMs(wall, tz);
  utc = wall - offsetMs(utc, tz); // the offset at the candidate instant (DST edge)
  return new Date(utc).toISOString();
}

/** `MM/DD/YYYY` -> `YYYY-MM-DD`, or null. @param {string | null} s */
function isoOfUs(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s ?? "").trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** The text of a namespaced or plain tag inside an item, or null. @param {string} item @param {string} tag */
function tag(item, tag) {
  const m = new RegExp(
    `<(?:[a-z]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z]+:)?${tag}>`,
    "i",
  ).exec(item);
  const t = m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
  return t === "" ? null : t;
}

/**
 * @typedef {{ code: string, kind: "luld" | "halt" | "suspension", haltedAt: string, resumedAt: string | null,
 *             reason: string | null, source: string }} HaltRow
 */

/**
 * The Nasdaq trade-halt RSS.
 * @param {string} xml @param {string} tz the exchange zone (the profile's `tz`)
 * @returns {{ rows: HaltRow[], skipped: number }}
 */
export function parseNasdaqHalts(xml, tz) {
  /** @type {HaltRow[]} */
  const rows = [];
  let skipped = 0;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const code = (tag(item, "IssueSymbol") ?? "").toUpperCase();
    const reason = (tag(item, "ReasonCode") ?? "").toUpperCase();
    const hd = isoOfUs(tag(item, "HaltDate"));
    const ht = tag(item, "HaltTime");
    if (code === "" || reason === "" || hd === null || ht === null || reason.startsWith("MWC")) {
      skipped += 1;
      continue;
    }
    let haltedAt;
    try {
      haltedAt = zonedToUtc(hd, ht, tz);
    } catch {
      skipped += 1;
      continue;
    }
    const rd = isoOfUs(tag(item, "ResumptionDate"));
    const rt = tag(item, "ResumptionTradeTime") ?? tag(item, "ResumptionQuoteTime");
    let resumedAt = null;
    if (rd !== null && rt !== null) {
      try {
        resumedAt = zonedToUtc(rd, rt, tz);
      } catch {
        resumedAt = null;
      }
    }
    /** @type {HaltRow["kind"]} */
    const kind = LULD_REASONS.has(reason) ? "luld" : reason === "H10" ? "suspension" : "halt";
    rows.push({ code, kind, haltedAt, resumedAt, reason, source: NASDAQ_HALTS_SOURCE });
  }
  return { rows, skipped };
}

/**
 * The SEC trading-suspension RSS: one `suspension` per item whose text carries a ticker.
 * @param {string} xml
 * @returns {{ rows: HaltRow[], skipped: number }}
 */
export function parseSecSuspensions(xml) {
  /** @type {HaltRow[]} */
  const rows = [];
  let skipped = 0;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    const text = `${tag(item, "title") ?? ""} ${tag(item, "description") ?? ""}`;
    const tk = /Ticker:?\s*([A-Z][A-Z.]{0,5})\b/.exec(text) ?? /\(([A-Z][A-Z.]{0,5})\)/.exec(text);
    const pub = tag(item, "pubDate");
    const t = pub === null ? NaN : Date.parse(pub);
    if (tk === null || !Number.isFinite(t)) {
      skipped += 1;
      continue;
    }
    rows.push({
      code: tk[1],
      kind: "suspension",
      haltedAt: new Date(t).toISOString(),
      resumedAt: null,
      reason: "sec_suspension",
      source: SEC_SUSPENSIONS_SOURCE,
    });
  }
  return { rows, skipped };
}

/**
 * Append the rows; set `resumed_at` once where the row existed unresumed. Returns counts.
 * @param {{ execute: Function, batch: Function }} db @param {string} market @param {HaltRow[]} rows
 * @returns {Promise<{ inserted: number, resumed: number }>}
 */
export async function writeHalts(db, market, rows) {
  await assertMarketEnabled(db, market);
  if (rows.length === 0) return { inserted: 0, resumed: 0 };
  const ins = rows.map((r) => ({
    // rows-ok: one insert per halt of the feed (tens a day), ignored when the halt exists
    sql: `INSERT INTO trading_halt (market, code, kind, halted_at, resumed_at, reason, source)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (market, code, halted_at, kind) DO NOTHING`,
    args: [market, r.code, r.kind, r.haltedAt, r.resumedAt, r.reason, r.source],
  }));
  const upd = rows
    .filter((r) => r.resumedAt !== null)
    .map((r) => ({
      // rows-ok: one update per resumed halt, by the unique (market, code, halted_at, kind); only an unresumed row moves
      sql: `UPDATE trading_halt SET resumed_at = ?
            WHERE market = ? AND code = ? AND halted_at = ? AND kind = ? AND resumed_at IS NULL`,
      args: [r.resumedAt, market, r.code, r.haltedAt, r.kind],
    }));
  const res = await db.batch([...ins, ...upd], "write");
  const inserted = res.slice(0, ins.length).reduce((a, x) => a + x.rowsAffected, 0);
  // an update right after its own insert changes nothing (the insert already carried resumed_at)
  const resumed = res.slice(ins.length).reduce((a, x) => a + x.rowsAffected, 0);
  return { inserted, resumed };
}
