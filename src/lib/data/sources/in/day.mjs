// India batch 1 (M20 IN1; D-1127, DAT-020, D-1119): `prepareDay` and `runDay`, found by the batch-1 dispatcher
// (`sources/<code>/day.mjs`, src/lib/data/pipeline/batch1-core.mjs). The shape matches the home market's day:
//   prepareDay(db, o) -> { action: "fetch" | "skip", target, files, sources, ... }   (read-only)
//   runDay(db, o)     -> { exit, status, target, dates: [{ d, status, ... }], ... }
// `o.files` is the day's raw files by key (the fetch step wrote them; a recorded fixture supplies the same keys):
//   bhavcopy (CSV)            required: a missing or empty file fails the date, nothing is invented (DAT-004)
//   bands (CSV)               price bands            asm, gsm (JSON text)   surveillance lists
//   announcements_nse (JSON)  headline + link only   announcements_bse (JSON)
//   insider (CSV)  fo_oi (CSV)  classification (CSV, monthly)  macro (CSV)  index (CSV, manual upload)
// Every write path calls `assertMarketEnabled` FIRST (MKT-110 a): with India off (production) `runDay` throws
// MarketNotEnabled before it reads a file, opens a run record or calls any client. Stages that fail are recorded in the
// run's details and never fail the bars (the bars are the primary product); a missing optional file is a stage word.
//
// Source rows (`source_register`, written on enable by `ensureMarketSources`): a source whose row is `disabled` is
// never processed - the announcement fetcher is not called and a file handed in is ignored (D-1125); a row that is
// `pending` is processed when a file is handed in (a recorded fixture or a file already held), but the polite client
// only ever FETCHES a source whose row is `enabled` (politeFetch.mjs). A source with no register row is "not registered".
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMarketEnabled } from "../../../market/scriptMarket.mjs";
import { staticProfile } from "../../../market/staticProfile.mjs";
import { CATEGORY_MAP } from "../../../market/seed/in/categoryMap.mjs";
import { writeAnnouncementCategory } from "../../../market/classifyCore.mjs";
import { isWalkDay } from "../../calendarCore.mjs";
import { assignTiers, medianMicro, tierRulesOf } from "../../universe/tiers.mjs";
import { qualityHook } from "../../quality/engine.mjs";
import { barPublishedAt, parseBhavcopy, priceBarRows, SOURCE as BAR_SOURCE } from "./bhavcopy.mjs";
import { parseBands, priceBandRows } from "./bands.mjs";
import { parseAsm, parseGsm, surveillanceRows } from "./surveillance.mjs";
import {
  announcementRows,
  BSE_SOURCE,
  NSE_SOURCE,
  parseBseAnnouncements,
  parseNseAnnouncements,
} from "./announcements.mjs";
import { insiderRows, parseInsiderNotices, SOURCE as INSIDER_SOURCE } from "./insider.mjs";
import { parseFoOi, shortInterestRows, SOURCE as FO_SOURCE } from "./foOi.mjs";
import { parseClassification, SOURCE as CLASS_SOURCE } from "./classification.mjs";
import { parseMacroCsv } from "./macro.mjs";
import { indexBarRows, parseIndexCsv, SOURCE as INDEX_SOURCE } from "./index.mjs";
import { istToUtcIso } from "./parse.mjs";

export const JOB = "ingest-batch1";
/** The market of this folder (`sources/<code>/day.mjs`, D-1127): the default when a caller names none. */
export const MARKET = path.basename(path.dirname(fileURLToPath(import.meta.url))).toUpperCase();
export const FILE_KEYS = Object.freeze([
  "bhavcopy",
  "bands",
  "asm",
  "gsm",
  "announcements_nse",
  "announcements_bse",
  "insider",
  "fo_oi",
  "classification",
  "macro",
  "index",
]);
/** The register id each optional file belongs to (a file with no entry here is processed whenever handed in). */
const SOURCE_OF_FILE = Object.freeze({
  bhavcopy: BAR_SOURCE,
  bands: "in_nse_bands",
  asm: "in_nse_asm_gsm",
  gsm: "in_nse_asm_gsm",
  announcements_nse: NSE_SOURCE,
  announcements_bse: BSE_SOURCE,
  insider: INSIDER_SOURCE,
  fo_oi: FO_SOURCE,
  classification: CLASS_SOURCE,
  index: INDEX_SOURCE,
});
const ROWS_PER_STATEMENT = 100;
const KEEP_FIRST = "first-seen: a stored row is never replaced";

const keyFor = (market, d) => `batch1:${market}:${d}`;

/** Multi-row INSERT ... ON CONFLICT DO NOTHING in one atomic batch; returns the rows inserted. */
async function insertRows(db, table, cols, rows) {
  if (rows.length === 0) return 0;
  const ph = `(${cols.map(() => "?").join(",")})`;
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      // rows-ok: a bounded multi-row insert (100 rows per statement), ignored when the key exists
      sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flat(),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

/** The status of each India register row the day uses: { id -> status } (rows-ok: at most 25 rows). */
async function registerStatus(db) {
  const rs = await db.execute({
    // rows-ok: the market's own register rows, at most 25 (D-1096)
    sql: "SELECT source, status FROM source_register WHERE source LIKE 'in\\_%' ESCAPE '\\'",
    args: [],
  });
  return new Map(rs.rows.map((r) => [String(r.source), String(r.status)]));
}

/** @returns {"ok" | "disabled" | "not_registered"} */
function fileGate(reg, key) {
  const id = SOURCE_OF_FILE[key];
  if (id === undefined) return "ok";
  const st = reg.get(id);
  if (st === undefined) return "not_registered";
  return st === "disabled" ? "disabled" : "ok";
}

async function calendarRowsOf(db, market, d) {
  const rs = await db.execute({
    // rows-ok: the market's calendar rows around one date (a window of a few hundred days at most)
    sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ? ORDER BY d",
    args: [market, shiftDays(d, -400), shiftDays(d, 3)],
  });
  return rs.rows.map((r) => ({
    d: String(r.d),
    kind: String(r.kind),
    close_time: r.close_time === null ? null : String(r.close_time),
    confirmed: Number(r.confirmed),
  }));
}

function shiftDays(d, n) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Read-only: what the fetch step should ask for. Writes nothing and never calls a client.
 * @param {{ execute: Function }} db @param {{ market?: string, target?: string, nowMs?: () => number }} o
 */
export async function prepareDay(db, o = {}) {
  const market = o.market ?? MARKET;
  // rows-ok: primary-key probe of the market row
  const m = await db.execute({
    sql: "SELECT enabled, mode FROM market WHERE code = ?",
    args: [market],
  });
  const target = o.target ?? new Date((o.nowMs ?? Date.now)()).toISOString().slice(0, 10);
  if (m.rows.length === 0 || Number(m.rows[0].enabled) !== 1)
    return { action: "skip", target, reason: "market_not_enabled" };
  const reg = await registerStatus(db);
  /** the files a polite fetch may request: only a source whose row is enabled */
  const fetchable = FILE_KEYS.filter((k) => reg.get(SOURCE_OF_FILE[k] ?? "") === "enabled");
  return {
    action: "fetch",
    target,
    mode: String(m.rows[0].mode),
    files: [...FILE_KEYS],
    fetchable,
    disabled: FILE_KEYS.filter((k) => fileGate(reg, k) === "disabled"),
  };
}

/**
 * Run one session's batch 1 for the market.
 * @param {import("@libsql/client").Client} db
 * @param {{ market?: string, d: string, files: Record<string, string | undefined>, nowMs: () => number,
 *   commitSha?: string, codeOfScrip?: (scrip: string) => string | null }} o
 */
export async function runDay(db, o) {
  const market = o.market ?? MARKET;
  await assertMarketEnabled(db, market); // FIRST: nothing below runs for a market that is not enabled
  const profile = staticProfile(market);
  const d = o.d;
  const iso = () => new Date(o.nowMs()).toISOString();
  const key = keyFor(market, d);
  const out = { d, status: "ok", bars: 0, rowsWritten: 0 };

  // PLT-076: a date that already succeeded is left alone
  const done = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    args: [key],
  });
  if (done.rows.length > 0)
    return { exit: 0, status: "skipped", target: d, dates: [{ ...out, status: "already_done" }] };

  const cal = await calendarRowsOf(db, market, d);
  const stages = {};
  const io = { read: 0, written: 0 };
  const started = await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, commit_sha)
          VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    args: [JOB, market, key, d, iso(), o.commitSha ?? null],
  });
  const runId = Number(started.lastInsertRowid);
  const finish = async (status, error, details) => {
    await db.execute({
      sql: `UPDATE run_record SET status = ?, ended_at = ?, rows_written = ?, rows_read = ?, error_summary = ?,
            details_json = ?, items_processed = ? WHERE id = ?`,
      args: [
        status,
        iso(),
        io.written,
        io.read,
        error ?? null,
        JSON.stringify(details),
        out.bars,
        runId,
      ],
    });
  };

  try {
    // Stage 1: calendar check (a weekday that is not a holiday row is a session; a missing row is reported, DAT-160)
    stages.calendar = {
      covered: cal.some((r) => r.d === d),
      confirmed: cal.some((r) => r.d === d && r.confirmed === 1),
    };
    if (!isWalkDay(d, cal)) {
      io.written += await insertRows(
        db,
        "completion_marker",
        ["market", "d", "kind", "at", "run_id", "outcome"],
        [[market, d, "non-trading", iso(), runId, "non-trading"]],
      );
      await finish("skipped", undefined, { reason: "non_trading_day" });
      return { exit: 0, status: "skipped", target: d, dates: [{ ...out, status: "non_trading" }] };
    }
    const closeTime = profile.sessionClose ?? "15:30";
    const latency = profile.barLatencyP95Min?.minutes ?? 60;
    const reg = await registerStatus(db);
    io.read += reg.size;

    // The bars file (stage 3's input). Missing or unreadable fails the date visibly.
    const barsText = o.files.bhavcopy;
    if (barsText === undefined || barsText.trim() === "") {
      await finish("failed", "validate: bars file missing", { stage: "validate" });
      return {
        exit: 1,
        status: "failed",
        reason: "validate",
        target: d,
        dates: [{ ...out, status: "failed" }],
      };
    }
    const bars = parseBhavcopy(barsText, { d });
    if (bars.rows.length === 0) {
      await finish("failed", "bars: no valid bars for the date", {
        stage: "bars",
        rejected: bars.rejected.length,
      });
      return {
        exit: 1,
        status: "failed",
        reason: "bars",
        target: d,
        dates: [{ ...out, status: "failed" }],
      };
    }

    // Instruments (a bar's code has an instrument row; the name comes from the bhavcopy)
    stages.instruments = await insertRows(
      db,
      "instrument",
      ["market", "code", "name"],
      bars.rows.map((r) => [market, r.code, r.name === "" ? r.code : r.name]),
    );
    io.written += stages.instruments;

    // Stage 2: universe snapshot with the market's tier table, capped by universe_max (60-session ADV)
    const universe = await tierUniverse(db, io, market, d, bars.rows, cal, profile);
    stages.universe = { rows: 0, capped: universe.capped };
    const snapRows = universe.rows.map((r) => [
      market,
      d,
      r.code,
      r.status,
      r.tier,
      null,
      r.adv,
      0,
    ]);
    const nSnap = await insertRows(
      db,
      "universe_snapshot",
      ["market", "d", "code", "status", "tier", "mcap_est", "adv", "halted"],
      snapRows,
    );
    io.written += nSnap;
    stages.universe.rows = nSnap;
    const inUniverse = new Set(universe.rows.map((r) => r.code));

    // Stage 3: bars, first-seen immutable
    const ingestedAt = iso();
    const publishedAt = barPublishedAt(d, closeTime, latency);
    const valid = bars.rows.filter((r) => inUniverse.has(r.code));
    const inserted = await insertRows(
      db,
      "price_bar",
      [
        "market",
        "code",
        "d",
        "o",
        "h",
        "l",
        "c",
        "volume",
        "source",
        "published_at",
        "ingested_at",
      ],
      priceBarRows(valid, { market, d, publishedAt, ingestedAt }),
    );
    io.written += inserted;
    out.bars = inserted;
    stages.bars = {
      valid: valid.length,
      inserted,
      already_stored: valid.length - inserted,
      rejected: bars.rejected.length,
      not_in_universe: bars.rows.length - valid.length,
    };

    // D-1105: when the bar was first seen, against the close, one sample per night
    const closeUtc = Date.parse(istToUtcIso(d, closeTime));
    const lat = Math.max(0, Math.round((Date.parse(ingestedAt) - closeUtc) / 60_000));
    io.written += await insertRows(
      db,
      "bar_latency_sample",
      ["market", "d", "close_local", "first_seen_at", "latency_min", "source"],
      [[market, d, closeTime, ingestedAt, lat, BAR_SOURCE]],
    );

    // Optional inputs: each stage is independent and never fails the bars
    const guarded = async (name, fn) => {
      try {
        stages[name] = await fn();
      } catch (e) {
        stages[name] = e && e.name === "MarketNotEnabled" ? "refused" : "failed";
      }
    };
    const files = o.files;
    const gate = (k) => (files[k] === undefined ? "no_file" : fileGate(reg, k));

    await guarded("bands", async () => {
      const g = gate("bands");
      if (g !== "ok") return g;
      const p = parseBands(files.bands);
      const rows = p.rows.filter((r) => inUniverse.has(r.code));
      const n = await insertRows(
        db,
        "price_band",
        ["market", "code", "d", "band_pct", "lower_micro", "upper_micro", "source"],
        priceBandRows(rows, { market, d }),
      );
      io.written += n;
      return { rows: rows.length, inserted: n, rejected: p.rejected };
    });

    await guarded("surveillance", async () => {
      const ga = gate("asm");
      const gg = gate("gsm");
      if (ga !== "ok" && gg !== "ok") return ga === "no_file" ? gg : ga;
      const asm = ga === "ok" ? parseAsm(JSON.parse(files.asm)) : [];
      const gsm = gg === "ok" ? parseGsm(JSON.parse(files.gsm)) : [];
      const rows = surveillanceRows(
        {
          asm: asm.filter((r) => inUniverse.has(r.code)),
          gsm: gsm.filter((r) => inUniverse.has(r.code)),
        },
        { market, d },
      );
      const n = await insertRows(
        db,
        "surveillance_list",
        ["market", "code", "d", "list", "stage", "source"],
        rows,
      );
      io.written += n;
      return { rows: rows.length, inserted: n };
    });

    await guarded("announcements", async () => {
      /** @type {any[]} */
      let items = [];
      const seen = {};
      for (const [k, parse] of [
        ["announcements_nse", (t) => parseNseAnnouncements(JSON.parse(t), { market })],
        [
          "announcements_bse",
          (t) =>
            parseBseAnnouncements(JSON.parse(t), {
              market,
              codeOfScrip: o.codeOfScrip ?? (() => null),
            }),
        ],
      ]) {
        const g = gate(k);
        if (g !== "ok") {
          seen[k] = g; // disabled (D-1125): the file is ignored
          continue;
        }
        const p = parse(files[k]);
        items = items.concat(p.items);
        seen[k] = { items: p.items.length, rejected: p.rejected };
      }
      items = items.filter((a) => inUniverse.has(a.code));
      const n = await insertRows(
        db,
        "announcement",
        [
          "market",
          "code",
          "ann_id",
          "published_at",
          "ingested_at",
          "type",
          "price_sensitive",
          "title",
          "url",
          "source",
        ],
        announcementRows(items, iso()),
      );
      io.written += n;
      // the category of every NEW row, by the market's map (never an LLM, AGT-011a); first classification kept
      let categorised = 0;
      for (const a of items) {
        await writeAnnouncementCategory(
          db,
          { market, source: a.source, annId: a.annId },
          CATEGORY_MAP,
          { type: a.type, title: a.title },
        );
        categorised += 1;
      }
      io.written += categorised;
      return { ...seen, inserted: n, categorised };
    });

    await guarded("insider", async () => {
      const g = gate("insider");
      if (g !== "ok") return g;
      const p = parseInsiderNotices(files.insider, { market });
      const rows = p.rows.filter((r) => inUniverse.has(r.code));
      const n = await insertRows(
        db,
        "insider_notice",
        ["market", "ann_id", "code", "kind", "value_micro", "published_at", "parser_version"],
        insiderRows(rows),
      );
      io.written += n;
      return { rows: rows.length, inserted: n, skipped: p.skipped };
    });

    await guarded("short_interest", async () => {
      const g = gate("fo_oi");
      if (g !== "ok") return g;
      const p = parseFoOi(files.fo_oi, { market });
      const rows = p.rows.filter((r) => inUniverse.has(r.code));
      const n = await insertRows(
        db,
        "short_interest",
        [
          "market",
          "code",
          "as_of",
          "short_ppm",
          "published_at",
          "ingested_at",
          "assumed_time",
          "source",
        ],
        shortInterestRows(rows, iso()),
      );
      io.written += n;
      return { rows: rows.length, inserted: n, kind: "proxy" };
    });

    await guarded("classification", async () => {
      const g = gate("classification");
      if (g !== "ok") return g;
      const list = parseClassification(files.classification).filter((r) => inUniverse.has(r.code));
      let n = 0;
      for (const r of list) {
        // rows-ok: one keyed update per classified code of the month's file (a monthly run only)
        const u = await db.execute({
          sql: "UPDATE instrument SET industry = ? WHERE market = ? AND code = ? AND (industry IS NULL OR industry <> ?)",
          args: [r.industry, market, r.code, r.industry],
        });
        n += u.rowsAffected;
      }
      io.written += n;
      return { rows: list.length, updated: n };
    });

    await guarded("macro", async () => {
      if (files.macro === undefined) return "no_file";
      const p = parseMacroCsv(files.macro);
      return { parsed: p.rows.length, skipped: p.skipped, stored: "not_stored" }; // D-1171
    });

    await guarded("index", async () => {
      const g = gate("index");
      if (g !== "ok") return g;
      const codes = [profile.benchmarkIndex, profile.volatilityIndex, profile.regimeIndex].filter(
        (c) => typeof c === "string",
      );
      const p = parseIndexCsv(files.index, {
        market,
        codes,
        closeLocal: closeTime,
        latencyMin: latency,
      });
      const rows = p.rows.filter((r) => r.d === d);
      const n = await insertRows(
        db,
        "index_bar",
        [
          "market",
          "index_code",
          "d",
          "o_micro",
          "h_micro",
          "l_micro",
          "c_micro",
          "source",
          "published_at",
          "ingested_at",
        ],
        indexBarRows(rows, { market, ingestedAt: iso() }),
      );
      io.written += n;
      return { rows: rows.length, inserted: n };
    });

    // Stage 8: data quality (the market-keyed engine)
    await guarded("quality", async () => {
      const q = await qualityHook({
        db,
        market,
        d,
        io,
        now: iso(),
        universe: universe.rows.length,
        barsValid: valid.length,
        rejected: [],
        refetchDiffs: [],
      });
      return q && typeof q.flags === "number" ? { flags: q.flags } : "done";
    });

    // Stage 9: completion marker (insert once)
    const covered = valid.length;
    const outcome =
      covered === universe.rows.length && bars.rejected.length === 0
        ? "complete"
        : `partial:${covered}/${universe.rows.length}`;
    io.written += await insertRows(
      db,
      "completion_marker",
      ["market", "d", "kind", "at", "run_id", "outcome"],
      [[market, d, "data", iso(), runId, outcome]],
    );
    await finish("success", undefined, {
      outcome,
      universe: universe.rows.length,
      stages,
      note: KEEP_FIRST,
    });
    return {
      exit: 0,
      status: "ok",
      target: d,
      dates: [{ ...out, rowsWritten: io.written, outcome, stages }],
    };
  } catch (e) {
    const summary =
      e && e.name === "MarketNotEnabled" ? "refused: market not enabled" : "unexpected error";
    try {
      await finish("failed", summary, { stages });
    } catch {
      // best effort: the exit code still fails the workflow
    }
    return {
      exit: 1,
      status: "failed",
      reason: "error",
      target: d,
      dates: [{ ...out, status: "failed" }],
    };
  }
}

/**
 * The night's tiers from the stored bars of the last `windowSessions` sessions BEFORE `d` (tonight's bar is stored in
 * stage 3, so the tier is known before the close it is used on), by the market's own table; a code below the U3 floor
 * is `below_floor`. The universe is capped at the profile's `universe_max` by 60-session median traded value (ties by
 * code), so a year of IN bars stays within the storage ceiling. Windows are bounded keyset-free reads of one code
 * chunk at a time (no OFFSET).
 */
async function tierUniverse(db, io, market, d, rows, cal, profile) {
  const rules = tierRulesOf(profile);
  let from = d;
  for (let i = 0, n = 0; n < rules.windowSessions && i < 400; i += 1) {
    from = shiftDays(from, -1);
    if (isWalkDay(from, cal)) n += 1;
  }
  const traded = new Map();
  const first = new Map();
  const codes = rows.map((r) => r.code);
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const rs = await db.execute({
      // rows-ok: <= 200 codes x the 60-session window, read once a night
      sql: `SELECT code, d, c, volume FROM price_bar WHERE market = ? AND d >= ? AND d < ?
            AND code IN (${chunk.map(() => "?").join(",")}) ORDER BY code, d`,
      args: [market, from, d, ...chunk],
    });
    io.read += rs.rows.length;
    for (const r of rs.rows) {
      const code = String(r.code);
      const price = BigInt(Math.round(Number(r.c) * 1e6)); // money-float-ok: vendor price to micro
      let l = traded.get(code);
      if (l === undefined) traded.set(code, (l = []));
      l.push(price * BigInt(Number(r.volume)));
      if (!first.has(code)) first.set(code, String(r.d));
    }
  }
  const tiers = assignTiers(
    rows.map((r) => ({
      code: r.code,
      priceMicro: BigInt(Math.round(r.close * 1e6)), // money-float-ok: vendor price to micro
      tradedMicro: traded.get(r.code) ?? [],
      listedSince: first.get(r.code) ?? null,
      mcapMicro: null,
    })),
    d,
    rules,
  );
  let list = rows.map((r) => {
    const t = tiers.get(r.code);
    const adv = t.advMicro === null ? null : Number(t.advMicro / 1_000_000n); // money-float-ok: Rs in a REAL column
    return { code: r.code, tier: t.tier, status: t.status, adv, rank: t.advMicro ?? 0n };
  });
  let capped = 0;
  const max = Number(profile.fields?.universe_max?.value ?? 0);
  if (max > 0 && list.length > max) {
    list = list
      .sort((a, b) => (a.rank > b.rank ? -1 : a.rank < b.rank ? 1 : a.code < b.code ? -1 : 1))
      .slice(0, max);
    capped = rows.length - max;
  }
  void medianMicro;
  return { rows: list.sort((a, b) => (a.code < b.code ? -1 : 1)), capped };
}
