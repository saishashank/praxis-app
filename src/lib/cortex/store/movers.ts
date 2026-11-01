// The store side of the movers gap additions (CR-MOV-A1, A2, A3, A8; D-740…D-759; migration 0024).
// Reads the live announcements, the archive, the view and the sector map; writes the append-only
// `halt_watch`, `angle_forward_flag`, `intraday_arm` and `sector_composite_daily` rows. Every writer is
// insert-or-ignore: a re-run of a night keeps the first rows. Nothing here touches an order, fill, book,
// ledger, lesson, card or score table (the additions are gates, states and facts outside the score).
import { addDays, nextTradingDay, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { getConfig } from "@/lib/config/store";
import { classifyPublication, type MarketHoursLocal, DEFAULT_HOURS } from "@/lib/sentinel/archive";
import type { Catalyst } from "@/lib/sentinel/todayItems";
import { angleById, defaultGrid } from "../angles/registry";
import type { GridPoint } from "../angles/types";
import { predictResultsDates, isResultsAnnouncement } from "../gates/resultsSeason";
import { buildMoversParams, MOVERS_PARAM_KEYS, type MoversParams } from "../moversParams";
import type { MoversNight } from "../moversNight";
import type { AsOfView } from "../pit/types";
import {
  stepHaltWatch,
  watchNoticeKind,
  WATCH_NONE,
  type ExpectedSign,
  type HaltReasonClass,
  type HaltWatchState,
  type HaltWatchView,
  type WatchNotice,
} from "../states/haltWatch";
import { num, str, strOrNull, type Exec } from "./common";

/** Calendar days of announcements read for halt notices and their neighbours. */
const NOTICE_DAYS = 14; // threshold-ok: read window, not a rule
/** The neighbours of a notice: the code's announcements within this many calendar days either side. */
const NEIGHBOUR_DAYS = 3; // threshold-ok: read window, not a rule
/** Calendar days of watch rows read back for the gates. */
const WATCH_DAYS = 60; // threshold-ok: read window, not a rule
const RESULTS_LOOKBACK_DAYS = 400; // threshold-ok: read window (resultsSeason.ts)
const MINUTES_PER_HOUR = 60; // threshold-ok: unit
const PPM = 1_000_000; // threshold-ok: unit
const MIN_LIQUID_PRICE = 1; // threshold-ok: D-200 interim movers rule, price floor (A$)
const MIN_LIQUID_VALUE = 1_000_000; // threshold-ok: D-200 interim movers rule, traded value (A$)
const SPLIT_GUARD = 0.6; // threshold-ok: |move| above 60 % is a corporate action, not a return
const SECTOR_LOOKBACK_DAYS = 7; // threshold-ok: the last completed session is at most this old

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / MINUTES_PER_HOUR)).padStart(2, "0")}:${String(minute % MINUTES_PER_HOUR).padStart(2, "0")}`;

// ---- parameters ------------------------------------------------------------------------------------

/** Effective values of the movers keys (stored override, else the registry default). */
export async function loadMoversParams(db: Exec): Promise<MoversParams> {
  const values = new Map<string, unknown>();
  for (const k of MOVERS_PARAM_KEYS) values.set(k, await getConfig(db, k));
  return buildMoversParams((k) => values.get(k));
}

/** The market's local hours (tz, open, close); the ASX regular session when the row is missing. */
export async function marketHoursOf(db: Exec, market: string): Promise<MarketHoursLocal> {
  const r = await db.execute({
    sql: "SELECT tz, open_time, close_time FROM market WHERE code = ?",
    args: [market],
  });
  if (r.rows.length === 0) return DEFAULT_HOURS;
  return {
    tz: str(r.rows[0]!.tz),
    open_time: str(r.rows[0]!.open_time),
    close_time: str(r.rows[0]!.close_time),
  };
}

// ---- A1: halt watch ----------------------------------------------------------------------------------

export type HaltWatchRow = HaltWatchView & {
  readonly code: string;
  readonly seq: number;
  readonly noticeSource: string | null;
  readonly noticeAnnId: string | null;
};

const toWatchRow = (r: Record<string, unknown>): HaltWatchRow => ({
  code: str(r.code),
  sinceD: str(r.since_d),
  seq: num(r.seq),
  status: str(r.status) === "resumed" ? "resumed" : "open",
  reasonClass: str(r.reason_class) as HaltReasonClass,
  expectedSign: num(r.expected_sign) as ExpectedSign,
  resumeD: strOrNull(r.resume_d),
  noticeSource: strOrNull(r.notice_source),
  noticeAnnId: strOrNull(r.notice_ann_id),
});

/** The latest row of every watch younger than `fromSinceD`, one per code (the newest since_d, then seq). */
export async function latestHaltWatch(
  db: Exec,
  market: string,
  fromSinceD: string,
): Promise<Map<string, HaltWatchRow>> {
  const r = await db.execute({
    sql:
      "SELECT w.code, w.since_d, w.seq, w.status, w.reason_class, w.expected_sign, w.notice_source, " +
      "w.notice_ann_id, w.resume_d FROM halt_watch w WHERE w.market = ? AND w.since_d >= ? " +
      "AND NOT EXISTS (SELECT 1 FROM halt_watch x WHERE x.market = w.market AND x.code = w.code " +
      "AND (x.since_d > w.since_d OR (x.since_d = w.since_d AND x.seq > w.seq))) ORDER BY w.code",
    args: [market, fromSinceD],
  });
  const out = new Map<string, HaltWatchRow>();
  for (const x of r.rows) {
    const row = toWatchRow(x as Record<string, unknown>);
    out.set(row.code, row);
  }
  return out;
}

type AnnRow = {
  code: string;
  source: string;
  annId: string;
  publishedAt: string;
  type: string | null;
  title: string;
};

async function recentAnnouncements(
  db: Exec,
  market: string,
  fromIso: string,
  toIso: string,
): Promise<Map<string, AnnRow[]>> {
  const r = await db.execute({
    sql:
      "SELECT code, source, ann_id, published_at, type, title FROM announcement " +
      "WHERE market = ? AND published_at >= ? AND published_at <= ? ORDER BY code, published_at, id",
    args: [market, fromIso, toIso],
  });
  const out = new Map<string, AnnRow[]>();
  for (const x of r.rows) {
    const row: AnnRow = {
      code: str(x.code),
      source: str(x.source),
      annId: str(x.ann_id),
      publishedAt: str(x.published_at),
      type: strOrNull(x.type),
      title: str(x.title),
    };
    const list = out.get(row.code) ?? [];
    list.push(row);
    out.set(row.code, list);
  }
  return out;
}

export type AdvanceWatchOptions = {
  readonly market: string;
  readonly d: string;
  readonly view: AsOfView;
  readonly t: number;
  readonly now: string;
  readonly calendar: readonly CalendarRow[];
  readonly hours: MarketHoursLocal;
};

/**
 * Steps the halt watch of every code with a recent halt / suspension notice or an open watch, and
 * appends the rows that changed (open, resumed). Point-in-time: only announcements published by the
 * cut-off of `d`; the traded / halted facts come from the view at `t`.
 */
export async function advanceHaltWatch(
  db: Exec,
  o: AdvanceWatchOptions,
): Promise<{ opened: number; resumed: number }> {
  const cutoff = o.view.cutoffUtc(o.t);
  const from = new Date(Date.parse(cutoff) - NOTICE_DAYS * 86_400_000).toISOString(); // threshold-ok: ms per day
  const anns = await recentAnnouncements(db, o.market, from, cutoff);
  const watch = await latestHaltWatch(db, o.market, addDays(o.d, -WATCH_DAYS));
  const codes = new Set<string>();
  for (const [code, list] of anns) {
    if (list.some((a) => watchNoticeKind(a.type, a.title) !== null)) codes.add(code);
  }
  for (const [code, w] of watch) if (w.status === "open") codes.add(code);
  let opened = 0;
  let resumed = 0;
  for (const code of [...codes].sort()) {
    const list = anns.get(code) ?? [];
    const notices: WatchNotice[] = [];
    for (const a of list) {
      const kind = watchNoticeKind(a.type, a.title);
      if (kind === null) continue;
      const near = list
        .filter(
          (b) =>
            Math.abs(Date.parse(b.publishedAt) - Date.parse(a.publishedAt)) <=
            NEIGHBOUR_DAYS * 86_400_000,
        ) // threshold-ok: ms per day
        .map((b) => b.title);
      notices.push({
        kind,
        ref: `${a.source}|${a.annId}`,
        effectiveD: classifyPublication(a.publishedAt, o.hours, o.calendar).sessionD,
        texts: [a.title, ...near.filter((x) => x !== a.title)],
      });
    }
    const prevRow = watch.get(code);
    const prev: HaltWatchState =
      prevRow !== undefined && prevRow.status === "open"
        ? {
            state: "open",
            sinceD: prevRow.sinceD,
            reasonClass: prevRow.reasonClass,
            expectedSign: prevRow.expectedSign,
            noticeRef:
              prevRow.noticeSource === null
                ? null
                : `${prevRow.noticeSource}|${prevRow.noticeAnnId}`,
          }
        : WATCH_NONE;
    const bars = o.view.bars(code, o.t, 1);
    const last = bars[bars.length - 1];
    const step = stepHaltWatch(prev, {
      d: o.d,
      haltedNow: o.view.halted(code, o.t),
      tradedNow: last !== undefined && last.d === o.d && last.volume > 0n,
      notices,
      lastResolvedSinceD:
        prevRow !== undefined && prevRow.status === "resumed" ? prevRow.sinceD : null,
    });
    if (step.row === null) continue;
    const row = step.row;
    const seq = prevRow !== undefined && prevRow.sinceD === row.sinceD ? prevRow.seq + 1 : 1;
    const [source, annId] = row.noticeRef === null ? [null, null] : row.noticeRef.split("|");
    const w = await db.execute({
      sql:
        "INSERT INTO halt_watch (market, code, since_d, seq, status, reason_class, expected_sign, " +
        "notice_source, notice_ann_id, resume_d, known_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      args: [
        o.market,
        code,
        row.sinceD,
        seq,
        row.status,
        row.reasonClass,
        row.expectedSign,
        source ?? null,
        annId ?? null,
        row.resumeD,
        o.now,
      ],
    });
    if (w.rowsAffected > 0) {
      if (row.status === "open") opened += 1;
      else resumed += 1;
    }
  }
  return { opened, resumed };
}

// ---- A2: known result dates ----------------------------------------------------------------------------

async function archiveSinceD(db: Exec, market: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT MIN(substr(known_at, 1, 10)) AS d FROM announcement_archive WHERE market = ?",
    args: [market],
  });
  const v = r.rows[0]?.d;
  return v === null || v === undefined ? null : str(v);
}

async function knownResultDates(
  db: Exec,
  market: string,
  d: string,
  params: MoversParams,
): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  const since = await archiveSinceD(db, market);
  if (since === null || since > addDays(d, -params.knownDateMinHistoryDays)) return out;
  const r = await db.execute({
    sql:
      "SELECT code, session_d, type, title FROM announcement_archive WHERE market = ? " +
      "AND session_d >= ? AND session_d <= ? AND known_at <= ? AND (" +
      "lower(coalesce(type, '') || ' ' || title) LIKE '%half%year%' " +
      "OR lower(coalesce(type, '') || ' ' || title) LIKE '%full%year%' " +
      "OR lower(coalesce(type, '') || ' ' || title) LIKE '%annual report%' " +
      "OR lower(coalesce(type, '') || ' ' || title) LIKE '%quarterly activities%' " +
      "OR lower(coalesce(type, '') || ' ' || title) LIKE '%preliminary final%' " +
      "OR lower(coalesce(type, '') || ' ' || title) LIKE '%appendix 4%') ORDER BY code, session_d",
    args: [market, addDays(d, -RESULTS_LOOKBACK_DAYS), d, `${d}T23:59:59.999Z`],
  });
  const byCode = new Map<string, { sessionD: string; type: string | null; title: string }[]>();
  for (const x of r.rows) {
    const type = strOrNull(x.type);
    const title = str(x.title);
    if (!isResultsAnnouncement(type, title)) continue;
    const list = byCode.get(str(x.code)) ?? [];
    list.push({ sessionD: str(x.session_d), type, title });
    byCode.set(str(x.code), list);
  }
  for (const [code, history] of byCode) {
    const dates = predictResultsDates({ d, history, archiveSinceD: since, params });
    if (dates.length > 0) out.set(code, dates);
  }
  return out;
}

// ---- the night's movers input -----------------------------------------------------------------------------

/** Everything the pure night core needs for the gate additions, read once. */
export async function loadMoversNight(
  db: Exec,
  o: { market: string; d: string; params: MoversParams },
): Promise<MoversNight> {
  const watch = await latestHaltWatch(db, o.market, addDays(o.d, -WATCH_DAYS));
  const haltWatch = new Map<string, HaltWatchView>();
  for (const [code, w] of watch) {
    haltWatch.set(code, {
      sinceD: w.sinceD,
      status: w.status,
      reasonClass: w.reasonClass,
      expectedSign: w.expectedSign,
      resumeD: w.resumeD,
    });
  }
  return {
    params: o.params,
    haltWatch,
    knownDates: await knownResultDates(db, o.market, o.d, o.params),
  };
}

// ---- A1, A3: arming the intraday scan ------------------------------------------------------------------------

async function armCount(db: Exec, market: string, sessionD: string): Promise<number> {
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM intraday_arm WHERE market = ? AND session_d = ?",
    args: [market, sessionD],
  });
  return num(r.rows[0]?.n ?? 0);
}

async function insertArm(
  db: Exec,
  a: {
    market: string;
    sessionD: string;
    code: string;
    reason: "halt_resume" | "volume_creep";
    expectedSign: ExpectedSign;
    armedFrom: string;
    ref: string;
    now: string;
  },
): Promise<boolean> {
  const r = await db.execute({
    sql:
      "INSERT INTO intraday_arm (market, session_d, code, reason, expected_sign, armed_from, ref, created_at) " +
      "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    args: [a.market, a.sessionD, a.code, a.reason, a.expectedSign, a.armedFrom, a.ref, a.now],
  });
  return r.rowsAffected > 0;
}

/**
 * Arms the intraday scan of `sessionD` for every open halt watch younger than the expiry and for every
 * code with a reinstatement notice published on `sessionD` before now (A1). Idempotent; capped by
 * `intraday_arm_codes_max` armed codes a session (first writers win).
 */
export async function armHaltResumes(
  db: Exec,
  o: {
    market: string;
    sessionD: string;
    now: string;
    params: MoversParams;
    calendar: readonly CalendarRow[];
    hours: MarketHoursLocal;
  },
): Promise<number> {
  let armed = 0;
  let used = await armCount(db, o.market, o.sessionD);
  const armedFrom = hhmm(o.params.haltResumeArmMinute);
  const watch = await latestHaltWatch(db, o.market, addDays(o.sessionD, -WATCH_DAYS));
  for (const [code, w] of [...watch].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (used >= o.params.intradayArmCodesMax) return armed;
    if (w.status !== "open" || w.sinceD >= o.sessionD) continue; // a notice of today is the scan's catalyst
    const age = sessionsBetween(w.sinceD, o.sessionD, o.calendar).length - 1;
    if (age < 1 || age > o.params.haltWatchExpirySessions) continue;
    if (
      await insertArm(db, {
        market: o.market,
        sessionD: o.sessionD,
        code,
        reason: "halt_resume",
        expectedSign: w.expectedSign,
        armedFrom,
        ref: `halt:${w.sinceD}`,
        now: o.now,
      })
    ) {
      armed += 1;
      used += 1;
    }
  }
  // reinstatement notices of the session itself (published before the arm time, known to the scan)
  const dayStart = new Date(Date.parse(`${o.sessionD}T00:00:00.000Z`) - 86_400_000).toISOString(); // threshold-ok: ms per day
  const anns = await recentAnnouncements(db, o.market, dayStart, o.now);
  for (const [code, list] of [...anns].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (used >= o.params.intradayArmCodesMax) return armed;
    const re = list.find(
      (a) =>
        watchNoticeKind(a.type, a.title) === "reinstatement" &&
        classifyPublication(a.publishedAt, o.hours, o.calendar).sessionD === o.sessionD,
    );
    if (re === undefined) continue;
    const prior = watch.get(code);
    if (
      await insertArm(db, {
        market: o.market,
        sessionD: o.sessionD,
        code,
        reason: "halt_resume",
        expectedSign: prior?.expectedSign ?? 0,
        armedFrom,
        ref: `reinstated:${re.annId}`,
        now: o.now,
      })
    ) {
      armed += 1;
      used += 1;
    }
  }
  return armed;
}

const TEXT_RESUME = "Trading resumes after a halt";
const TEXT_CREEP = "Volume well above normal with no news";

/** The armed codes of a session whose arm time has passed, as synthetic catalysts for the scan (AGT-141a). */
export async function armedCatalysts(
  db: Exec,
  o: { market: string; sessionD: string; nowLocalHhmm: string; cap: number },
): Promise<Map<string, Catalyst>> {
  const out = new Map<string, Catalyst>();
  if (o.cap <= 0) return out;
  const r = await db.execute({
    sql:
      "SELECT code, reason, expected_sign, ref, created_at FROM intraday_arm WHERE market = ? " +
      "AND session_d = ? AND armed_from <= ? ORDER BY CASE reason WHEN 'halt_resume' THEN 0 ELSE 1 END, code",
    args: [o.market, o.sessionD, o.nowLocalHhmm],
  });
  for (const x of r.rows) {
    if (out.size >= o.cap) break;
    const sign = num(x.expected_sign);
    out.set(str(x.code), {
      source: "arm",
      annId: `${str(x.reason)}:${str(x.ref)}`,
      title: str(x.reason) === "halt_resume" ? TEXT_RESUME : TEXT_CREEP,
      publishedAt: str(x.created_at),
      category: str(x.reason),
      materiality: 2,
      polarity: sign > 0 ? 1 : sign < 0 ? -1 : 0,
    });
  }
  return out;
}

// ---- A3: forward measurement of A-D2-07 ------------------------------------------------------------------------------

/** One-at-a-time neighbourhood of an angle's grid: the default point and every alternative value. */
export function gridNeighbourhood(grid: Readonly<Record<string, readonly number[]>>): GridPoint[] {
  const base: Record<string, number> = {};
  for (const [k, pts] of Object.entries(grid)) base[k] = pts[0]!;
  const out: GridPoint[] = [{ ...base }];
  for (const [k, pts] of Object.entries(grid)) {
    for (const v of pts.slice(1)) out.push({ ...base, [k]: v });
  }
  return out;
}

const gridKey = (g: GridPoint): string =>
  Object.keys(g)
    .sort()
    .map((k) => `${k}=${g[k]}`)
    .join(",");

/**
 * Evaluates A-D2-07 for the whole universe at every pre-registered grid point and appends the flagged
 * names (`angle_forward_flag`), whatever the angle's passport status: this is the live measurement the
 * forward passport reads (CTX-051). The default point also arms the intraday scan of the next session
 * (volume creep, no catalyst needed), universe tier 1 first, capped by `intraday_arm_codes_max`.
 */
export async function recordCreepFlags(
  db: Exec,
  o: {
    market: string;
    d: string;
    view: AsOfView;
    t: number;
    now: string;
    params: MoversParams;
    calendar: readonly CalendarRow[];
    hours: MarketHoursLocal;
  },
): Promise<{ flagged: number; armed: number }> {
  const def = angleById("A-D2-07");
  if (def === undefined || def.compute === undefined) return { flagged: 0, armed: 0 };
  const points = gridNeighbourhood(def.grid);
  const dflt = gridKey(defaultGrid(def));
  let flagged = 0;
  const armCandidates: string[] = [];
  for (const code of o.view.codes(o.t)) {
    for (const g of points) {
      if (def.compute(o.view, code, o.t, g) !== 1) continue;
      const key = gridKey(g);
      const w = await db.execute({
        sql:
          "INSERT INTO angle_forward_flag (market, d, code, angle_id, grid_key, angle_version, known_at) " +
          "VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        args: [o.market, o.d, code, def.id, key, def.version, o.now],
      });
      flagged += w.rowsAffected;
      if (key === dflt) armCandidates.push(code);
    }
  }
  const next = nextTradingDay(o.d, o.calendar);
  const rank = (c: string): number => (o.view.tier(c, o.t) === "U1" ? 0 : 1);
  armCandidates.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  let used = await armCount(db, o.market, next);
  let armed = 0;
  for (const code of armCandidates) {
    if (used >= o.params.intradayArmCodesMax) break;
    if (
      await insertArm(db, {
        market: o.market,
        sessionD: next,
        code,
        reason: "volume_creep",
        expectedSign: 0,
        armedFrom: hhmm(o.params.haltResumeArmMinute),
        ref: `${def.id}:${dflt}:${o.d}`,
        now: o.now,
      })
    ) {
      armed += 1;
      used += 1;
    }
  }
  return { flagged, armed };
}

// ---- A8: EOD sector composite ----------------------------------------------------------------------------------------------

/**
 * Equal-weight daily return per industry over the liquid universe of session `d` (prior-session price
 * >= A$1 and traded value >= A$1m, the D-200 interim rule), from the CURRENT sector map (D-271, labelled
 * `map_as_of`). A bar pair that moved more than 60 % is a corporate action and is left out. Idempotent.
 */
export async function writeSectorComposite(
  db: Exec,
  o: { market: string; d: string; now: string },
): Promise<{ industries: number }> {
  const bars = await db.execute({
    sql:
      "SELECT c.code AS code, c.c AS c1, p.c AS c0, p.volume AS v0, c.volume AS v1 FROM price_bar c " +
      "JOIN price_bar p ON p.market = c.market AND p.code = c.code AND p.d = " +
      "(SELECT MAX(d) FROM price_bar WHERE market = ? AND d < ?) WHERE c.market = ? AND c.d = ?",
    args: [o.market, o.d, o.market, o.d],
  });
  const cls = await db.execute({
    sql: "SELECT code, industry, as_of FROM instrument_class WHERE market = ? AND as_of <= ? ORDER BY code, as_of",
    args: [o.market, o.d],
  });
  const industry = new Map<string, { industry: string; asOf: string }>();
  for (const x of cls.rows)
    industry.set(str(x.code), { industry: str(x.industry), asOf: str(x.as_of) });
  const groups = new Map<string, { sum: number; n: number; asOf: string }>();
  for (const x of bars.rows) {
    const ind = industry.get(str(x.code));
    if (ind === undefined) continue;
    const c0 = Number(x.c0); // money-float-ok: a statistic over stored floats, never money
    const c1 = Number(x.c1); // money-float-ok: a statistic over stored floats, never money
    if (!(c0 >= MIN_LIQUID_PRICE) || !(c1 > 0)) continue;
    if (c0 * Number(x.v0) < MIN_LIQUID_VALUE || !(Number(x.v1) > 0)) continue; // money-float-ok: liquidity filter
    const ret = c1 / c0 - 1;
    if (Math.abs(ret) > SPLIT_GUARD) continue;
    const g = groups.get(ind.industry) ?? { sum: 0, n: 0, asOf: ind.asOf };
    g.sum += ret;
    g.n += 1;
    if (ind.asOf > g.asOf) g.asOf = ind.asOf;
    groups.set(ind.industry, g);
  }
  let written = 0;
  for (const [name, g] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const r = await db.execute({
      sql:
        "INSERT INTO sector_composite_daily (market, d, industry, ret_ppm, n_members, map_as_of, created_at) " +
        "VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      args: [o.market, o.d, name, Math.round((g.sum / g.n) * PPM), g.n, g.asOf, o.now],
    });
    written += r.rowsAffected;
  }
  return { industries: written };
}

export type SectorReturn = { readonly retPpm: number; readonly members: number };

/** The composite of the latest completed session before `sessionD` (at most a week old), by industry. */
export async function sectorReturns(
  db: Exec,
  market: string,
  sessionD: string,
): Promise<Map<string, SectorReturn>> {
  const r = await db.execute({
    sql:
      "SELECT industry, ret_ppm, n_members FROM sector_composite_daily WHERE market = ? " +
      "AND d = (SELECT MAX(d) FROM sector_composite_daily WHERE market = ? AND d < ? AND d >= ?)",
    args: [market, market, sessionD, addDays(sessionD, -SECTOR_LOOKBACK_DAYS)],
  });
  const out = new Map<string, SectorReturn>();
  for (const x of r.rows)
    out.set(str(x.industry), { retPpm: num(x.ret_ppm), members: num(x.n_members) });
  return out;
}

// ---- the Owner review line ---------------------------------------------------------------------------------------------------------

export type HaltAttention = {
  readonly code: string;
  readonly reasonClass: HaltReasonClass;
  readonly expectedSign: ExpectedSign;
  readonly sinceD: string;
};

/** Open halt watches as of `d` (younger than the expiry): the codes the Owner mail should mention. */
export async function openHaltWatches(
  db: Exec,
  market: string,
  d: string,
  expirySessions: number,
  calendar: readonly CalendarRow[],
): Promise<HaltAttention[]> {
  const watch = await latestHaltWatch(db, market, addDays(d, -WATCH_DAYS));
  const out: HaltAttention[] = [];
  for (const [code, w] of watch) {
    if (w.status !== "open") continue;
    if (sessionsBetween(w.sinceD, d, calendar).length - 1 > expirySessions) continue;
    out.push({ code, reasonClass: w.reasonClass, expectedSign: w.expectedSign, sinceD: w.sinceD });
  }
  return out.sort((a, b) => (a.code < b.code ? -1 : 1));
}
