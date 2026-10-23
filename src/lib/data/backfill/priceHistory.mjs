// Price-history backfill (M4 T4, D-086 draft; DAT-125, DAT-126, DAT-140, design decision 11).
// HIGH-RISK (production writes, the data-repo token). Yahoo daily bars go into the same write-once
// monthly history files as D-065 (`history/yahoo_prices/<yyyy>/<mm>.jsonl.gz`, release
// `history-yahoo_prices-<yyyy>`, asset `yahoo_prices-<yyyy>-<mm>.jsonl.gz`), newest month first
// down to HISTORY_YEARS, one commit per month: file first (SHA-skip makes a re-run a no-op), then
// ONE database batch (cursor + success run record + state), so a kill leaves all or nothing.
//
// Raw reconstruction (DAT-126 "tier, tick, parcel and stop computations use raw prices"): Yahoo
// returns split-adjusted prices (D-064: adjusted = raw x f for bars BEFORE the ex-date, volume / f).
// Stored bars are raw: raw = vendor / F and volume = vendor volume x F, where F is the product of
// the factors of every action with ex-date AFTER the bar's date. Factors come from CONFIRMED
// `corporate_action` rows first; a vendor-reported split with no confirmed action within 3 days is
// used too (recorded as `vendor_only`). A vendor split that disagrees with a confirmed factor, a
// factor that disagrees with an announcement title ("2 for 1 split"), or a reversed close ratio
// across the ex-date that is not within the tolerance of the factor, rejects the month: nothing is
// written until the Owner resolves it (DAT-004: never repair silently).
// The Yahoo source stays `pending` until O-26: the gate then reports status `source_off`.
// No network here: the (no-secrets) fetch step hands the month's bars in; see the T4 report for
// the workflow step that is still needed.
import { HistoryConflict } from "./dataRepo.mjs";
import { monthUsage } from "./engine.mjs";
import {
  ADMIN_WRITES,
  BACKFILL_WRITE_CAP_MONTH,
  MARKET,
  RUN_JOB,
  addDays,
  capDecision,
  floorDate,
  gzipDeterministic,
  isMonth,
  isRealDate,
  isValidCode,
  lastCompleteMonth,
  monthFirstDay,
  monthLastDay,
  monthOf,
  quotaMonth,
  sydneyDate,
  toJsonl,
} from "./rules.mjs";
import { isEffective, stateOf } from "../corporateActions/rules.mjs";

export const JOB_YAHOO = "yahoo_prices";
/** `source_register` / `source_status` id of the vendor (DAT-103, O-26). */
export const YAHOO_SOURCE = "yahoo_eod";
export const PRICE_SOURCE_TAG = "yahoo_eod";
/** corporate_action_price_tolerance default (D-064), percent. */
export const DEFAULT_TOLERANCE_PCT = 10;
/** A vendor split within this many days of a confirmed action is the same event. */
export const VENDOR_MATCH_DAYS = 3;
const TITLE_WINDOW_DAYS = 7;
const MAX_BARS_PER_MONTH = 200_000;
const cursorJob = (name) => `backfill:${name}`;

/** Where a price month lives in the private data repo (same shape as D-065). @param {string} month */
export function priceHistoryLocation(month) {
  if (!isMonth(month)) throw new RangeError("bad history key");
  const [yyyy, mm] = month.split("-");
  return {
    tag: `history-${JOB_YAHOO}-${yyyy}`,
    asset: `${JOB_YAHOO}-${yyyy}-${mm}.jsonl.gz`,
    path: `history/${JOB_YAHOO}/${yyyy}/${mm}.jsonl.gz`,
  };
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** ASX price step for a price (ASX Operating Rules tick table): the raw price must sit on it. */
export function tickFor(price) {
  return price < 0.1 ? 0.001 : price < 2 ? 0.005 : 0.01;
}
export function onTick(price) {
  const q = price / tickFor(price);
  return Math.abs(q - Math.round(q)) < 1e-6 * Math.max(1, q);
}

/**
 * The factor product that turns a vendor (split-adjusted) bar of `date` into a raw bar: the
 * product of the factor of every action with ex-date AFTER `date`. A bar ON the ex-date is raw.
 * @param {{ exDate: string, factor: number }[]} factors @param {string} date
 */
export function cumulativeFactor(factors, date) {
  let f = 1;
  for (const x of factors) if (x.exDate > date) f *= x.factor;
  return f;
}

/**
 * Reverse the adjustment of one vendor bar (raw = vendor / F, volume x F). Prices are rounded to
 * 6 decimals, volume to a whole share. `f === 1` returns the bar unchanged.
 */
export function reverseBar(bar, f) {
  if (f === 1) return { ...bar };
  return {
    ...bar,
    o: round6(bar.o / f),
    h: round6(bar.h / f),
    l: round6(bar.l / f),
    c: round6(bar.c / f),
    volume: Math.round(bar.volume * f),
  };
}

/** Exact "A for B" reading of a corporate-action title; null when it has no terms. */
export function titleFactor(title) {
  const t = String(title).toLowerCase();
  const kind = /consolidat|reverse split/.test(t)
    ? "consolidation"
    : /split|subdivi/.test(t)
      ? "split"
      : /bonus/.test(t)
        ? "bonus"
        : null;
  if (kind === null) return null;
  const m = /(\d+)\s*(?:-|\s)?\s*for\s*(?:-|\s)?\s*(\d+)/.exec(t);
  if (!m) return null;
  const a = Number(m[1]); // new shares
  const b = Number(m[2]); // old shares
  if (!(a > 0) || !(b > 0)) return null;
  // "A for B": B old become A new (split/consolidation, f = old/new); a bonus gives A extra per B.
  if (kind === "bonus") return { kind, factor: b / (b + a) };
  return { kind, factor: b / a };
}

const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));

/**
 * Reconstruct a month of raw bars and validate the reversal.
 * @param {{ code: string, d: string, o: number, h: number, l: number, c: number, volume: number }[]} bars
 * @param {{ factors: { code: string, exDate: string, factor: number, actionId?: number }[],
 *   vendorSplits?: { code: string, exDate: string, ratio: number }[],
 *   titles?: { code: string, publishedAt: string, title: string }[],
 *   vendor?: "adjusted" | "raw", tolerancePct?: number,
 *   prior?: { code: string, d: string, c: number }[] }} o  prior = raw closes of earlier days
 * @returns {{ rows: object[], findings: { code: string, kind: string, exDate?: string }[],
 *   usedFactors: { code: string, exDate: string, factor: number, from: string }[], reversed: number }}
 */
export function reconstructRaw(bars, o) {
  const findings = [];
  const tol = (o.tolerancePct ?? DEFAULT_TOLERANCE_PCT) / 100;
  const vendorRaw = o.vendor === "raw";
  const byCode = new Map();
  for (const b of bars) {
    if (!byCode.has(b.code)) byCode.set(b.code, []);
    byCode.get(b.code).push(b);
  }
  const codes = [...byCode.keys()].sort();
  const rows = [];
  const usedFactors = [];
  let reversed = 0;

  for (const code of codes) {
    const own = byCode.get(code).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    // Confirmed factors first; a vendor split matches one within VENDOR_MATCH_DAYS.
    const conf = o.factors
      .filter((x) => x.code === code)
      .map((x) => ({ exDate: x.exDate, factor: x.factor, from: "confirmed" }));
    const factors = [...conf];
    for (const v of (o.vendorSplits ?? []).filter((x) => x.code === code)) {
      const vf = 1 / v.ratio;
      const match = conf.find(
        (c) => Math.abs(Date.parse(c.exDate) - Date.parse(v.exDate)) <= VENDOR_MATCH_DAYS * 864e5,
      );
      if (match) {
        if (!near(match.factor, vf, 1e-6)) {
          findings.push({ code, kind: "vendor_factor_conflict", exDate: match.exDate });
        }
      } else {
        factors.push({ exDate: v.exDate, factor: vf, from: "vendor_only" });
      }
    }
    factors.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0));
    usedFactors.push(...factors.map((x) => ({ code, ...x })));

    // Announcement titles must agree with the factor of the action they describe.
    for (const x of factors) {
      for (const t of (o.titles ?? []).filter((y) => y.code === code)) {
        const day = t.publishedAt.slice(0, 10);
        if (Math.abs(Date.parse(day) - Date.parse(x.exDate)) > TITLE_WINDOW_DAYS * 864e5) continue;
        const tf = titleFactor(t.title);
        if (tf !== null && !near(tf.factor, x.factor, 1e-6)) {
          findings.push({ code, kind: "title_mismatch", exDate: x.exDate });
        }
      }
    }

    const raw = [];
    for (const b of own) {
      const f = vendorRaw ? 1 : cumulativeFactor(factors, b.d);
      const r = reverseBar(b, f);
      if (f !== 1) reversed += 1;
      const flags = [];
      if (f !== 1 && !onTick(r.c)) flags.push("off_tick");
      raw.push({ d: b.d, o: r.o, h: r.h, l: r.l, c: r.c, volume: r.volume, f, flags });
    }
    // The raw close must jump by the factor across each ex-date (within the tolerance).
    const prior = (o.prior ?? []).filter((p) => p.code === code).map((p) => ({ d: p.d, c: p.c }));
    const closes = [...prior, ...raw.map((r) => ({ d: r.d, c: r.c }))].sort((a, b) =>
      a.d < b.d ? -1 : a.d > b.d ? 1 : 0,
    );
    for (const x of factors) {
      const i = closes.findIndex((c) => c.d >= x.exDate);
      if (i <= 0 || closes[i].d !== x.exDate) continue; // ex-date bar or its predecessor missing
      const ratio = closes[i].c / closes[i - 1].c;
      if (Math.abs(ratio / x.factor - 1) > tol) {
        findings.push({ code, kind: "ratio_mismatch", exDate: x.exDate });
      }
    }
    for (const r of raw) {
      rows.push({
        code,
        d: r.d,
        o: r.o,
        h: r.h,
        l: r.l,
        c: r.c,
        volume: r.volume,
        source: PRICE_SOURCE_TAG,
        adj: r.f === 1 ? "none" : "reversed",
        ...(r.flags.length ? { flags: r.flags } : {}),
      });
    }
  }
  return { rows, findings, usedFactors, reversed };
}

/** Bars of one month: a bad row rejects the whole input (nothing is repaired, DAT-004). */
export function validateBars(bars, month) {
  if (!Array.isArray(bars) || bars.length > MAX_BARS_PER_MONTH) return "bad_input";
  const seen = new Set();
  const out = [];
  for (const b of bars) {
    if (b === null || typeof b !== "object") return "bad_bar";
    const { code, d, o, h, l, c, volume } = b;
    if (!isValidCode(code) || !isRealDate(d) || monthOf(d) !== month) return "bad_bar";
    for (const v of [o, h, l, c]) if (!Number.isFinite(v) || v <= 0) return "bad_bar";
    if (!Number.isInteger(volume) || volume < 0) return "bad_bar";
    if (h < Math.max(o, c, l) - 1e-9 || l > Math.min(o, c, h) + 1e-9) return "bad_bar";
    const k = `${code}|${d}`;
    if (seen.has(k)) return "duplicate_bar";
    seen.add(k);
    out.push({ code, d, o, h, l, c, volume });
  }
  return out;
}

/**
 * Bars of one month, split by company (DAT-004, D-168): a company with any bad or duplicate bar is
 * set aside for the month with its reason, and the other companies go ahead. Nothing is repaired.
 * A file that is not a list, is too big, or holds a non-object row is still rejected whole.
 * @returns {{ bars: object[], excluded: Map<string, string> } | string}
 */
export function partitionBars(bars, month) {
  if (!Array.isArray(bars) || bars.length > MAX_BARS_PER_MONTH) return "bad_input";
  const seen = new Set();
  const excluded = new Map();
  const ok = [];
  for (const b of bars) {
    if (b === null || typeof b !== "object") return "bad_bar";
    const code = typeof b.code === "string" ? b.code : "?";
    const one = validateBars([b], month);
    const k = `${code}|${b.d}`;
    if (typeof one === "string") {
      if (!excluded.has(code)) excluded.set(code, one);
    } else if (seen.has(k)) {
      if (!excluded.has(code)) excluded.set(code, "duplicate_bar");
    } else {
      seen.add(k);
      ok.push(one[0]);
    }
  }
  return { bars: ok.filter((b) => !excluded.has(b.code)), excluded };
}

/** Count by reason and the first codes (for run details; codes are public tickers, no values). */
export function excludedSummary(excluded) {
  const reasons = {};
  for (const r of excluded.values()) reasons[r] = (reasons[r] ?? 0) + 1;
  const codes = [...excluded.keys()].sort().slice(0, 50);
  return { count: excluded.size, reasons, codes };
}

// ---- job state (backfill_job + ingest_cursor, same tables as the D-065 jobs) ----------------------

const stateStmt = (state, nowIso) => ({
  sql: `INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (job, market, source) DO UPDATE SET cursor_json = excluded.cursor_json,
        updated_at = excluded.updated_at`,
  args: [cursorJob(JOB_YAHOO), MARKET, YAHOO_SOURCE, JSON.stringify(state), nowIso],
});

export const initialPriceCursor = (nowMs) => monthLastDay(lastCompleteMonth(sydneyDate(nowMs)));

export async function ensurePriceJob(db, nowMs) {
  await db.execute({
    sql: "INSERT INTO backfill_job (name, source, next_date, done, rows_written_month) VALUES (?, ?, ?, 0, 0) ON CONFLICT DO NOTHING",
    args: [JOB_YAHOO, YAHOO_SOURCE, initialPriceCursor(nowMs)],
  });
}

export async function readPriceState(db) {
  const r = await db.execute({
    sql: "SELECT cursor_json FROM ingest_cursor WHERE job = ? AND market = ? AND source = ?",
    args: [cursorJob(JOB_YAHOO), MARKET, YAHOO_SOURCE],
  });
  if (!r.rows.length) return { status: "new" };
  try {
    const v = JSON.parse(String(r.rows[0].cursor_json));
    return v && typeof v === "object" && !Array.isArray(v) ? v : { status: "new" };
  } catch {
    return { status: "new" };
  }
}

export async function getPriceJob(db) {
  const r = await db.execute({
    sql: "SELECT next_date, done, rows_written_month FROM backfill_job WHERE name = ?",
    args: [JOB_YAHOO],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    nextDate: row.next_date === null ? null : String(row.next_date),
    done: Number(row.done) === 1,
    rowsWrittenMonth: Number(row.rows_written_month),
    state: await readPriceState(db),
  };
}

async function setStatus(db, state, status, reason, nowIso) {
  if (state.status === status && (state.reason ?? null) === (reason ?? null)) return state;
  const next = { ...state, status, reason: reason ?? null };
  await db.execute(stateStmt(next, nowIso));
  return next;
}

/**
 * DAT-120/123/127: the vendor is fetched only when the Owner accepted it (register `enabled`, O-26)
 * AND the source is on. Returns null when open, else the reason.
 */
export async function priceGate(db) {
  const reg = await db.execute({
    sql: "SELECT status FROM source_register WHERE source = ?",
    args: [YAHOO_SOURCE],
  });
  const status = reg.rows.length ? String(reg.rows[0].status) : "missing";
  if (status === "disabled") return "source_disabled";
  if (status !== "enabled") return "source_not_accepted";
  const st = await db.execute({
    sql: "SELECT mode FROM source_status WHERE source = ?",
    args: [YAHOO_SOURCE],
  });
  return st.rows.length && String(st.rows[0].mode) === "on" ? null : "source_off";
}

/** Confirmed factors of the codes (newest factor row per confirmed action; DAT-222 recomputes add rows). */
export async function loadConfirmedFactors(db, codes) {
  const out = [];
  for (const code of [...codes].sort()) {
    const acts = await db.execute({
      sql: `SELECT ca.id AS id, ca.ex_date AS ex_date,
              (SELECT e.status FROM corporate_action_event e WHERE e.action_id = ca.id
                 ORDER BY e.id DESC LIMIT 1) AS status,
              (SELECT e.note FROM corporate_action_event e WHERE e.action_id = ca.id
                 ORDER BY e.id DESC LIMIT 1) AS note,
              (SELECT f.factor FROM adjustment_factor f WHERE f.market = ca.market
                 AND f.corporate_action_id = ca.id ORDER BY f.computed_at DESC LIMIT 1) AS factor
            FROM corporate_action ca WHERE ca.market = ? AND ca.code = ? ORDER BY ca.ex_date, ca.id`,
      args: [MARKET, code],
    });
    for (const r of acts.rows) {
      if (r.status === null || r.factor === null) continue;
      const st = stateOf({
        status: String(r.status),
        note: r.note === null ? null : String(r.note),
      });
      if (isEffective(st.state)) {
        out.push({
          code,
          exDate: String(r.ex_date),
          factor: Number(r.factor),
          actionId: Number(r.id),
        });
      }
    }
  }
  return out;
}

/** Recent announcement titles near any ex-date; older ones were pruned (no title, no check). */
async function loadTitles(db, factors) {
  const out = [];
  for (const x of factors) {
    const r = await db.execute({
      sql: `SELECT code, published_at, title FROM announcement WHERE market = ? AND code = ?
            AND published_at >= ? AND published_at < ? ORDER BY published_at, ann_id`,
      args: [
        MARKET,
        x.code,
        `${addDays(x.exDate, -TITLE_WINDOW_DAYS)}T00:00:00.000Z`,
        `${addDays(x.exDate, TITLE_WINDOW_DAYS + 1)}T00:00:00.000Z`,
      ],
    });
    for (const row of r.rows) {
      out.push({
        code: String(row.code),
        publishedAt: String(row.published_at),
        title: String(row.title),
      });
    }
  }
  return out;
}

/** What the fetch step should fetch this run (read-only apart from a status change). */
export async function planPrices(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  await ensurePriceJob(db, o.nowMs);
  const job = await getPriceJob(db);
  if (job.done || job.nextDate === null) return { action: "none", reason: "done" };
  const closed = await priceGate(db);
  if (closed !== null) {
    await setStatus(db, job.state, "source_off", closed, nowIso);
    return { action: "none", reason: "source_off" };
  }
  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed: ADMIN_WRITES }).ok) {
    await setStatus(db, job.state, "paused_cap", "write_cap", nowIso);
    return { action: "none", reason: "paused_cap" };
  }
  return { action: "fetch", month: monthOf(job.nextDate) };
}

/**
 * Commit one price month: reconstruct raw, validate, upload the write-once file, move the cursor.
 * @param {import("@libsql/client").Client} db
 * @param {{ month: string, bars: unknown[], vendorSplits?: object[], vendor?: "adjusted" | "raw",
 *   store: { put: Function }, nowMs: number, cap?: number, tolerancePct?: number,
 *   commitSha?: string }} o
 */
export async function commitPriceMonth(db, o) {
  const cap = o.cap ?? BACKFILL_WRITE_CAP_MONTH;
  const nowIso = new Date(o.nowMs).toISOString();
  if (!isMonth(o.month)) return { status: "rejected", reason: "bad_input" };
  await ensurePriceJob(db, o.nowMs);
  const job = await getPriceJob(db);
  if (job.done || job.nextDate === null) return { status: "done" };
  const closed = await priceGate(db);
  if (closed !== null) {
    job.state = await setStatus(db, job.state, "source_off", closed, nowIso);
    return { status: "source_off", reason: closed };
  }
  const expected = monthOf(job.nextDate);
  if (o.month > expected) return { status: "already_done" };
  if (o.month < expected) return { status: "out_of_order", expected };

  const split = partitionBars(o.bars, o.month);
  if (typeof split === "string") return { status: "rejected", reason: split };
  const { bars, excluded } = split;

  const used = await monthUsage(db, o.nowMs);
  if (!capDecision({ used, cap, needed: ADMIN_WRITES }).ok) {
    job.state = await setStatus(db, job.state, "paused_cap", "write_cap", nowIso);
    return { status: "paused_cap", used, cap, needed: ADMIN_WRITES };
  }

  const codes = [...new Set(bars.map((b) => b.code))];
  const factors = await loadConfirmedFactors(db, codes);
  const titles = await loadTitles(db, factors);
  const rec = reconstructRaw(bars, {
    factors,
    vendorSplits: /** @type {any} */ (o.vendorSplits ?? []),
    titles,
    vendor: o.vendor,
    tolerancePct: o.tolerancePct,
  });
  // A split-factor finding sets that company's month aside (D-168); its bars are not saved.
  for (const f of rec.findings) if (!excluded.has(f.code)) excluded.set(f.code, f.kind);
  if (rec.findings.length > 0) rec.rows = rec.rows.filter((r) => !excluded.has(r.code));
  const set = excludedSummary(excluded);

  let file = null;
  if (rec.rows.length > 0) {
    // Rows are already sorted (code, then date); the bytes are deterministic (D-065).
    const bytes = gzipDeterministic(toJsonl(rec.rows));
    try {
      file = await o.store.put(priceHistoryLocation(o.month), bytes);
    } catch (e) {
      if (e instanceof HistoryConflict) {
        job.state = await setStatus(db, job.state, "failed", "history_conflict", nowIso);
        return { status: "conflict" };
      }
      throw e;
    }
  }

  const today = sydneyDate(o.nowMs);
  const nextDate = addDays(monthFirstDay(o.month), -1);
  const done = nextDate < floorDate(today);
  const streak = rec.rows.length === 0 ? Number(job.state.empty_streak ?? 0) + 1 : 0;
  const state = {
    ...job.state,
    status: done ? "done" : "active",
    reason: done ? "floor" : null,
    empty_streak: streak,
    writes_month: quotaMonth(o.nowMs).start.slice(0, 7),
    last_month: o.month,
  };
  const base = job.state.writes_month === state.writes_month ? job.rowsWrittenMonth : 0;
  const stmts = [
    {
      sql: "UPDATE backfill_job SET next_date = ?, done = ?, rows_written_month = ? WHERE name = ?",
      args: [done ? null : nextDate, done ? 1 : 0, base + ADMIN_WRITES, JOB_YAHOO],
    },
    {
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at,
              status, items_processed, rows_read, rows_written, llm_tokens, duration_ms, details_json, commit_sha)
            VALUES (?, ?, ?, ?, ?, ?, 'success', ?, 0, ?, 0, 0, ?, ?)`,
      args: [
        RUN_JOB,
        MARKET,
        `${RUN_JOB}:${JOB_YAHOO}:${o.month}`,
        nextDate,
        nowIso,
        nowIso,
        rec.rows.length,
        ADMIN_WRITES,
        JSON.stringify({
          kind: "price_month",
          month: o.month,
          rows: rec.rows.length,
          reversed: rec.reversed,
          vendor_only_factors: rec.usedFactors.filter((x) => x.from === "vendor_only").length,
          excluded: set,
          file: file === null ? null : { result: file.result, sha256: file.sha256 },
        }),
        o.commitSha ?? null,
      ],
    },
    stateStmt(state, nowIso),
  ];
  try {
    await db.batch(stmts, "write");
  } catch (e) {
    if (/constraint|unique/i.test(String(e?.code ?? "") + String(e?.message ?? ""))) {
      return { status: "already_done" };
    }
    throw e;
  }
  return {
    status: "ok",
    rows: rec.rows.length,
    excluded: set.count,
    excludedReasons: set.reasons,
    reversed: rec.reversed,
    file: file === null ? "none" : file.result,
    nextDate: done ? null : nextDate,
    done,
  };
}
