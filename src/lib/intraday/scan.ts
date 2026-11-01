// M17 WP5: one scan evaluation (AGT-140/141/142/143): delayed quotes joined to today's catalysts,
// the candidate rule, the gates, and the shadow candidate rows. Every row is a shadow row (the
// stream state is recorded in `gates_json`); nothing here touches an order, book or ledger. The only
// write target is `intraday_candidate`. Idempotent: the primary key (market, session, code) keeps
// the first row (point-in-time, DAT-240).
import { addDays } from "@/lib/data/calendar";
import { quoteAgeMin } from "@/lib/data/quotes/parse";
import type { DelayedQuote } from "@/lib/data/quotes/types";
import type { Exec } from "@/lib/cortex/store/common";
import { makeRational, type Rational } from "@/lib/money/rational";
import type { Catalyst } from "@/lib/sentinel/todayItems";
import { isCandidate, type CandidateParams } from "./candidate";
import { scanGates, type EodBar, type ScanGateInput } from "./gates";
import { indicativeLevels, type FamilyStopRule } from "./levels";
import { sectorReturns, type SectorReturn } from "@/lib/cortex/store/movers";
import { DEFAULT_MOVERS_PARAMS } from "@/lib/cortex/moversParams";
import { heldCodes, type ScanCode } from "./universe";

const PPM = 1_000_000; // threshold-ok: unit
const HISTORY_DAYS = 150; // threshold-ok: calendar days that cover 61 sessions with holidays
const ATR_PERIOD = 20; // threshold-ok: AGT-030 ATR(20)
const SD_SESSIONS = 60; // threshold-ok: AGT-141 60-session sd
const MIN_SESSION_FRACTION = 0.05; // threshold-ok: lower bound of the volume pro-rating
const NAV_ORDER_PERCENT = 100n; // threshold-ok: indicative order = 1 % of arena NAV for the cap gate
const INDICATIVE_BOOK = "intraday";

export type ScanParams = CandidateParams & {
  indexChangeWindowSessions: number;
  maxBooksSameCode: number;
  maxCodeNavShare: number;
  maxIndustryNavShare: number;
  /** Stop distance of the default family stop rule, in ATR. */
  stopAtr: number;
  /** `intraday_stream_state`; recorded on every row, never written here. */
  streamState: string;
  /** `sector_composite_min_members` (A8, D-750); absent = the registry default. */
  sectorMinMembers?: number;
};

/**
 * A8 (D-750): the move net of the industry's last completed end-of-day composite. There is no intraday
 * sector series (D-445), so the composite of the previous session stands in: it is taken off only when
 * it points the same way as the move (a continuing sector wave never inflates a candidate; an opposite
 * sector never shrinks one). Null when the industry is unknown or has fewer than `minMembers` members:
 * the raw move then stands (the market fallback).
 */
export function sectorAdjustedMove(
  movePpm: number,
  sector: SectorReturn | undefined,
  minMembers: number,
): number | null {
  if (sector === undefined || sector.members < minMembers) return null;
  return Math.sign(sector.retPpm) === Math.sign(movePpm) ? movePpm - sector.retPpm : movePpm;
}

export type EvaluateInput = {
  market: string;
  sessionD: string;
  /** Local "HH:MM" of the slot. */
  slot: string;
  now: Date;
  open: Date;
  close: Date;
  quotes: readonly DelayedQuote[];
  codes: ReadonlyMap<string, ScanCode>;
  catalysts: ReadonlyMap<string, Catalyst>;
  params: ScanParams;
};

export type EvaluateResult = {
  written: number;
  gateFailed: number;
  /** Quotes that carried a catalyst but no cumulative volume (System Health "volume unavailable"). */
  volumeUnavailable: number;
  considered: number;
};

type History = { bars: EodBar[]; closes: number[]; volumes: number[] };

/** REAL dollars from the bar table to micro, rounded (stored floats carry binary noise). */
const microOf = (v: number): bigint => BigInt(Math.round(v * PPM)); // money-float-ok: rounded at the boundary, display and gating only

const ratOf = (x: number): Rational => makeRational(BigInt(Math.round(x * PPM)), BigInt(PPM));

async function loadHistory(
  db: Exec,
  market: string,
  sessionD: string,
  codes: readonly string[],
): Promise<Map<string, History>> {
  const out = new Map<string, History>();
  if (codes.length === 0) return out;
  const r = await db.execute({
    sql:
      `SELECT code, d, o, h, l, c, volume FROM price_bar WHERE market = ? AND d < ? AND d >= ? ` +
      `AND code IN (${codes.map(() => "?").join(",")}) ORDER BY code, d`,
    args: [market, sessionD, addDays(sessionD, -HISTORY_DAYS), ...codes],
  });
  for (const x of r.rows) {
    const code = String(x.code);
    const h = out.get(code) ?? { bars: [], closes: [], volumes: [] };
    out.set(code, h);
    h.bars.push({
      d: String(x.d),
      open: microOf(Number(x.o)),
      high: microOf(Number(x.h)),
      low: microOf(Number(x.l)),
      close: microOf(Number(x.c)),
      volume: BigInt(Math.round(Number(x.volume))),
    });
    h.closes.push(Number(x.c));
    h.volumes.push(Number(x.volume));
  }
  return out;
}

/** Standard deviation of the last 60 daily returns, ppm; null with fewer than 61 closes. */
function sd60Ppm(closes: readonly number[]): number | null {
  if (closes.length < SD_SESSIONS + 1) return null;
  const tail = closes.slice(-(SD_SESSIONS + 1));
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1] <= 0) return null;
    rets.push(tail[i] / tail[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.round(Math.sqrt(v) * PPM);
}

function avgVolume20(volumes: readonly number[]): number | null {
  if (volumes.length < ATR_PERIOD) return null;
  const t = volumes.slice(-ATR_PERIOD);
  return t.reduce((a, b) => a + b, 0) / ATR_PERIOD;
}

/** Wilder ATR(20) in micro; null with fewer than 21 bars. */
export function atrMicro(bars: readonly EodBar[]): bigint | null {
  if (bars.length < ATR_PERIOD + 1) return null;
  const n = BigInt(ATR_PERIOD);
  const tr: bigint[] = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    const b = bars[i];
    const a1 = b.high - b.low;
    const a2 = b.high > pc ? b.high - pc : pc - b.high;
    const a3 = b.low > pc ? b.low - pc : pc - b.low;
    tr.push(a1 > a2 ? (a1 > a3 ? a1 : a3) : a2 > a3 ? a2 : a3);
  }
  let atr = tr.slice(0, ATR_PERIOD).reduce((a, b) => a + b, 0n) / n;
  for (const t of tr.slice(ATR_PERIOD)) atr = (atr * (n - 1n) + t) / n;
  return atr;
}

type World = {
  indexChangesLoaded: boolean;
  navMicro: bigint;
  exposures: { bookId: string; code: string; industry: string | null; exposureMicro: bigint }[];
  industryOf: Map<string, string>;
  held: Set<string>;
};

async function loadWorld(db: Exec, market: string, sessionD: string): Promise<World> {
  const ic = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM index_change WHERE market = ?",
    args: [market],
  });
  const nav = await db.execute(
    "SELECT COALESCE(SUM(nav_micro), 0) AS n FROM nav_daily WHERE d = (SELECT MAX(d) FROM nav_daily)",
  );
  const cls = await db.execute({
    sql:
      "SELECT code, industry FROM instrument_class WHERE market = ? AND as_of <= ? " +
      "ORDER BY code, as_of",
    args: [market, sessionD],
  });
  const industryOf = new Map<string, string>();
  for (const x of cls.rows) industryOf.set(String(x.code), String(x.industry)); // newest as_of wins
  const pos = await db.execute(
    "SELECT cohort_id, code, value_micro FROM nav_daily_pos WHERE d = (SELECT MAX(d) FROM nav_daily_pos)",
  );
  return {
    indexChangesLoaded: Number(ic.rows[0]?.n ?? 0) > 0,
    navMicro: BigInt(String(nav.rows[0]?.n ?? 0)),
    exposures: pos.rows.map((x) => ({
      bookId: String(x.cohort_id),
      code: String(x.code),
      industry: industryOf.get(String(x.code)) ?? null,
      exposureMicro: BigInt(String(x.value_micro)),
    })),
    industryOf,
    held: await heldCodes(db, market),
  };
}

async function stateWord(
  db: Exec,
  market: string,
  code: string,
  kind: string,
  d: string,
): Promise<string | null> {
  const r = await db.execute({
    sql:
      "SELECT state FROM cortex_state WHERE market = ? AND code = ? AND kind = ? AND from_d <= ? " +
      "ORDER BY from_d DESC LIMIT 1",
    args: [market, code, kind, d],
  });
  return r.rows.length === 0 ? null : String(r.rows[0].state);
}

type GateEvents = ScanGateInput["eventState"]["events"];

async function gateInput(
  db: Exec,
  x: EvaluateInput,
  w: World,
  code: string,
  hist: History | undefined,
  sc: ScanCode | undefined,
): Promise<ScanGateInput> {
  const bars = hist?.bars ?? [];
  const changes = await db.execute({
    sql:
      "SELECT index_name, kind, announced_d, effective_d FROM index_change " +
      "WHERE market = ? AND code = ? ORDER BY effective_d",
    args: [x.market, code],
  });
  const events = await db.execute({
    sql: "SELECT source, ann_id, day0_d, category FROM event WHERE market = ? AND code = ? AND day0_d = ?",
    args: [x.market, code, x.sessionD],
  });
  const industry = w.industryOf.get(code) ?? null;
  const advMicro = sc?.adv === null || sc?.adv === undefined ? null : microOf(sc.adv);
  // The G08 check reads only id, day0 and category of an event.
  const gateEvents = events.rows.map((e) => ({
    id: `${String(e.source)}:${String(e.ann_id)}`,
    day0: String(e.day0_d),
    category: String(e.category),
  })) as unknown as GateEvents;
  const orderValue = w.navMicro / NAV_ORDER_PERCENT;
  return {
    bar: bars.length > 0 ? bars[bars.length - 1] : null,
    barCount: bars.length,
    advMicro,
    heldAlready: w.held.has(code),
    eventState: {
      d: x.sessionD,
      fillD: x.sessionD,
      indexChangesLoaded: w.indexChangesLoaded,
      indexChanges: changes.rows.map((c) => ({
        indexName: String(c.index_name),
        kind: String(c.kind) === "add" ? "add" : "delete",
        announced: c.announced_d === null ? null : String(c.announced_d),
        effective: String(c.effective_d),
      })),
      sessions: [...bars.map((b) => b.d), x.sessionD],
      indexChangeWindowSessions: x.params.indexChangeWindowSessions,
      promotionState: await stateWord(db, x.market, code, "promotion", x.sessionD),
      haltState: await stateWord(db, x.market, code, "halt", x.sessionD),
      haltedNow: sc?.halted ?? null,
      corpActionState: await stateWord(db, x.market, code, "corp_action", x.sessionD),
      events: gateEvents,
    },
    portfolio:
      w.navMicro > 0n
        ? {
            bookId: INDICATIVE_BOOK,
            code,
            industry,
            orderValueMicro: orderValue > 0n ? orderValue : 1n,
            exposures: w.exposures,
            arenaNavMicro: w.navMicro,
            caps: {
              maxBooksSameCode: x.params.maxBooksSameCode,
              maxCodeNavShare: ratOf(x.params.maxCodeNavShare),
              maxIndustryNavShare: ratOf(x.params.maxIndustryNavShare),
            },
          }
        : null,
  };
}

/** Fraction of the session elapsed at the quote time, floored so early quotes are not noise. */
function sessionFraction(quoteAt: Date, open: Date, close: Date): number {
  const span = close.getTime() - open.getTime();
  if (span <= 0) return 1;
  const f = (quoteAt.getTime() - open.getTime()) / span;
  return Math.min(1, Math.max(MIN_SESSION_FRACTION, f));
}

const polarityWord = (p: number): string => (p > 0 ? "positive" : p < 0 ? "negative" : "neutral");

export async function evaluateQuotes(db: Exec, x: EvaluateInput): Promise<EvaluateResult> {
  const res: EvaluateResult = { written: 0, gateFailed: 0, volumeUnavailable: 0, considered: 0 };
  const withCatalyst = x.quotes.filter((q) => x.catalysts.has(q.code));
  if (withCatalyst.length === 0) return res;
  const hist = await loadHistory(
    db,
    x.market,
    x.sessionD,
    withCatalyst.map((q) => q.code),
  );
  const world = await loadWorld(db, x.market, x.sessionD);
  const sectors = await sectorReturns(db, x.market, x.sessionD);
  const minMembers = x.params.sectorMinMembers ?? DEFAULT_MOVERS_PARAMS.sectorCompositeMinMembers;
  for (const q of withCatalyst) {
    res.considered += 1;
    const cat = x.catalysts.get(q.code)!;
    const h = hist.get(q.code);
    if (q.prevCloseMicro === null || q.prevCloseMicro <= 0n) continue;
    const movePpm = Number(((q.lastMicro - q.prevCloseMicro) * BigInt(PPM)) / q.prevCloseMicro);
    // A later slot with a usable quote refreshes the follow-up columns of an existing row, whatever
    // today's verdict is (the 0020 trigger allows exactly these columns). The row itself is never re-decided.
    const have = await db.execute({
      sql: "SELECT 1 FROM intraday_candidate WHERE market = ? AND session_d = ? AND code = ?",
      args: [x.market, x.sessionD, q.code],
    });
    if (have.rows.length > 0) {
      if (quoteAgeMin(q, x.now) <= x.params.maxAgeMin) {
        await db.execute({
          sql:
            "UPDATE intraday_candidate SET latest_quote_at = ?, latest_move_ppm = ? " +
            "WHERE market = ? AND session_d = ? AND code = ? " +
            "AND (latest_quote_at IS NULL OR latest_quote_at < ?)",
          args: [q.quoteAt, movePpm, x.market, x.sessionD, q.code, q.quoteAt],
        });
      }
      continue;
    }
    const avg = h === undefined ? null : avgVolume20(h.volumes);
    const frac = sessionFraction(new Date(q.quoteAt), x.open, x.close);
    const relVolumePpm =
      q.cumVolume === null || avg === null || avg <= 0
        ? null
        : Math.round((q.cumVolume / (avg * frac)) * PPM);
    if (q.cumVolume === null) res.volumeUnavailable += 1;
    const industry = world.industryOf.get(q.code);
    const sectorAdjPpm = sectorAdjustedMove(
      movePpm,
      industry === undefined ? undefined : sectors.get(industry),
      minMembers,
    );
    const verdict = isCandidate({
      catalyst: cat,
      movePpm,
      sectorAdjPpm,
      sd60Ppm: h === undefined ? null : sd60Ppm(h.closes),
      relVolumePpm,
      quoteAgeMin: quoteAgeMin(q, x.now),
      params: x.params,
    });
    if (!verdict.ok) continue;
    const gates = scanGates(await gateInput(db, x, world, q.code, h, x.codes.get(q.code)));
    if (gates.failed !== null) res.gateFailed += 1;
    const atr = h === undefined ? null : atrMicro(h.bars);
    const rule: FamilyStopRule | null =
      atr === null ? null : { atrMicro: atr, multPpm: BigInt(Math.round(x.params.stopAtr * PPM)) };
    const levels = indicativeLevels(q.lastMicro, rule);
    const r = await db.execute({
      sql:
        "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
        "item_ann_id, item_category, materiality, polarity, move_ppm, sector_adj_ppm, rel_volume_ppm, " +
        "gates_json, indicative_limit_micro, indicative_stop_micro, latest_quote_at, latest_move_ppm) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (market, session_d, code) DO UPDATE SET latest_quote_at = excluded.latest_quote_at, " +
        "latest_move_ppm = excluded.latest_move_ppm",
      args: [
        x.market,
        x.sessionD,
        q.code,
        x.slot,
        q.quoteAt,
        cat.source,
        cat.annId,
        cat.category,
        cat.materiality,
        polarityWord(cat.polarity),
        movePpm,
        sectorAdjPpm,
        relVolumePpm,
        JSON.stringify({
          passed: gates.passed,
          failed: gates.failed,
          polarity_consistent: verdict.polarityConsistent,
          stream_state: x.params.streamState,
          delayed: true,
        }),
        levels === null ? null : Number(levels.limitMicro),
        levels === null ? null : Number(levels.stopMicro),
        q.quoteAt,
        movePpm,
      ],
    });
    res.written += r.rowsAffected;
  }
  return res;
}
