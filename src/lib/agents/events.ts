// A2 events (M4 T6; AGT-020, ARN-020; docs/M4_design.md 2.3, decision 16). One event record per
// announcement: a versioned rule table gives the category (ASX type code first, then title
// patterns, first match wins, unmatched = other); the day-0 session comes from the publication
// instant and the calendar; the day-0 abnormal return is an exact rational (numerator and
// denominator as decimal text, D-079) that rules compare without rounding; the polarity is by
// rule. LLM fields stay NULL (AGT-011a). Nothing here reads a clock or a random source.
import {
  isTradingDay,
  marketDate,
  nextTradingDay,
  sessionTimes,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import { makeRational, mulRat, subRat, cmpRat, type Rational } from "@/lib/money/rational";
import type { EventCategory, EventRow, Polarity } from "./schema";
import type { AgentParams } from "./params";
import type { AnnouncementRow, DecisionView } from "./decisionView";
import { volumeRatio } from "./indicators";
import { roundHalfAway } from "./regime";

export const EVENT_RULE_VERSION = "events-v1";

export type EventRule = {
  readonly id: string;
  readonly category: EventCategory;
  /** Lower-case ASX announcement type codes matched exactly (pass one). */
  readonly types: readonly string[];
  /** Case-insensitive, word-bounded title patterns (pass two). */
  readonly titles: readonly string[];
};

/** The versioned rule table (order matters: first match wins within each pass). */
export const EVENT_RULES_V1: readonly EventRule[] = [
  {
    id: "halt",
    category: "halt_suspension",
    types: ["trading halt", "suspension from quotation"],
    titles: [
      "\\btrading halt\\b",
      "\\bsuspension from (official )?quotation\\b",
      "\\bvoluntary suspension\\b",
    ],
  },
  {
    id: "query",
    category: "exchange_query",
    types: ["price query", "aware letter"],
    titles: ["\\bprice (and volume )?query\\b", "\\baware letter\\b", "\\bresponse to asx\\b"],
  },
  {
    id: "holder",
    category: "substantial_holder",
    types: [
      "change in substantial holding",
      "becoming a substantial holder",
      "ceasing to be a substantial holder",
    ],
    titles: [
      "\\bsubstantial holder\\b",
      "\\bchange in substantial holding\\b",
      "\\bbecoming a substantial\\b",
      "\\bceasing to be a substantial\\b",
    ],
  },
  {
    id: "director",
    category: "director_trade",
    types: ["director's interest notice"],
    titles: [
      "\\bappendix 3[xyz]\\b",
      "\\b(change of|initial|final) director'?s interest\\b",
      "\\bdirector'?s interest notice\\b",
    ],
  },
  {
    id: "target",
    category: "takeover_target",
    types: [],
    titles: [
      "\\btakeover (offer|bid|proposal)\\b",
      "\\bscheme (of arrangement|implementation deed)\\b",
      "\\bnon-binding (indicative )?(offer|proposal)\\b",
      "\\btarget'?s statement\\b",
    ],
  },
  {
    id: "bidder",
    category: "takeover_bidder",
    types: [],
    titles: [
      "\\bbidder'?s statement\\b",
      "\\bproposed acquisition of\\b",
      "\\boffer to acquire\\b",
    ],
  },
  {
    id: "guidance-down",
    category: "guidance_down",
    types: [],
    titles: [
      "\\b(downgrades?|downgraded|lowers?|lowered|reduces?|reduced|cuts?|withdraws?|withdrawn)\\b.{0,40}\\b(guidance|earnings|outlook|forecasts?)\\b",
      "\\b(guidance|earnings|outlook|forecasts?)\\b.{0,40}\\b(downgrade[sd]?|lowered|reduced|cut|withdrawn)\\b",
      "\\bprofit warning\\b",
      "\\bbelow (market )?expectations\\b",
    ],
  },
  {
    id: "guidance-up",
    category: "guidance_up",
    types: [],
    titles: [
      "\\b(upgrades?|upgraded|raises?|raised|increases?|increased|lifts?|lifted)\\b.{0,40}\\b(guidance|earnings|outlook|forecasts?)\\b",
      "\\b(guidance|earnings|outlook|forecasts?)\\b.{0,40}\\b(upgrade[sd]?|raised|increased|lifted)\\b",
      "\\bahead of (market )?expectations\\b",
    ],
  },
  {
    id: "capital",
    category: "capital_raising",
    types: ["proposed issue of securities"],
    titles: [
      "\\bcapital raising\\b",
      "\\b(placement|entitlement offer|rights issue|share purchase plan|equity raising)\\b",
      "\\bconvertible (note|bond)s?\\b",
      "\\bproposed issue of securities\\b",
    ],
  },
  {
    id: "contract",
    category: "contract_win",
    types: [],
    titles: [
      "\\b(wins?|won|awarded|secures?|secured)\\b.{0,40}\\b(contracts?|orders?|tender)\\b",
      "\\b(contracts?|orders?|tender)\\b.{0,30}\\b(awarded|win|secured)\\b",
      "\\bnew (customer )?contract\\b",
    ],
  },
  {
    id: "results",
    category: "results",
    types: [],
    titles: [
      "\\b(full|half)[- ]year (financial )?results\\b",
      "\\b(annual|preliminary final) report\\b",
      "\\bresults for (the )?(half|year|quarter)\\b",
      "\\bappendix 4[cde]\\b",
      "\\bquarterly (activities|cash ?flow) report\\b",
      "\\bfinancial results\\b",
    ],
  },
  {
    id: "dividend",
    category: "dividend_change",
    types: [],
    titles: ["\\bdividend\\b", "\\bdistribution (rate|announcement|policy)\\b"],
  },
  {
    id: "management",
    category: "management_change",
    types: [],
    titles: [
      "\\b(appoint(s|ed|ment)?|resign(s|ed|ation)?|retire(s|d|ment)?|cessation of)\\b.{0,30}\\b(ceo|chief|managing director|chair(man|woman|person)?|director|cfo|coo)\\b",
      "\\bchange of (ceo|chief|chair|company secretary)\\b",
    ],
  },
];

const compiled = new Map<string, RegExp[]>();
function patternsOf(rule: EventRule): RegExp[] {
  let c = compiled.get(rule.id);
  if (c === undefined) {
    c = rule.titles.map((t) => new RegExp(t, "i"));
    compiled.set(rule.id, c);
  }
  return c;
}

export type Classified = { category: EventCategory; rule: string };

/** Category of one announcement: type code pass, then title pass, else `other`. */
export function classifyAnnouncement(type: string | null, title: string): Classified {
  const t = type === null ? "" : type.trim().toLowerCase();
  if (t.length > 0) {
    for (const rule of EVENT_RULES_V1) {
      if (rule.types.includes(t)) return { category: rule.category, rule: `type:${rule.id}` };
    }
  }
  for (const rule of EVENT_RULES_V1) {
    if (patternsOf(rule).some((re) => re.test(title))) {
      return { category: rule.category, rule: `title:${rule.id}` };
    }
  }
  return { category: "other", rule: "none" };
}

/** Fixed polarity categories (AGT-020); the rest take the sign of the day-0 abnormal return. */
const FIXED_POLARITY: Partial<Record<EventCategory, Polarity>> = {
  guidance_up: 1,
  contract_win: 1,
  takeover_target: 1,
  guidance_down: -1,
  capital_raising: -1,
  exchange_query: -1,
  halt_suspension: -1,
};

/** Polarity by rule: fixed per category, else sign(AR) when |AR| > threshold (strict), else 0. */
export function eventPolarity(
  category: EventCategory,
  ar: Rational | null,
  threshold: Rational,
): Polarity {
  const fixed = FIXED_POLARITY[category];
  if (fixed !== undefined) return fixed;
  if (ar === null) return 0;
  const mag = ar.num < 0n ? makeRational(-ar.num, ar.den) : ar;
  if (cmpRat(mag, threshold) <= 0) return 0;
  return ar.num > 0n ? 1 : -1;
}

const MS_PER_MINUTE = 60_000; // threshold-ok: unit conversion minutes -> milliseconds

export type Day0 = { day0: string; timed: boolean };

/**
 * Day 0 (ARN-020): the session during which the item was published; the next session when it
 * came at or after that session's continuous-trading end (calendar close - offset; the early
 * close is used on early-close days) or on a non-trading day. A date-only publication is an
 * untimed (assumed-time) item: its date if a trading day, else the next.
 */
export function day0Of(
  publishedAt: string,
  calendar: readonly CalendarRow[],
  hours: MarketHours,
  closeOffsetMin: number,
): Day0 {
  if (!publishedAt.includes("T")) {
    const day0 = isTradingDay(publishedAt, calendar)
      ? publishedAt
      : nextTradingDay(publishedAt, calendar);
    return { day0, timed: false };
  }
  const at = new Date(publishedAt);
  if (Number.isNaN(at.getTime())) throw new RangeError(`bad published_at: ${publishedAt}`);
  const local = marketDate(at, hours.tz);
  if (!isTradingDay(local, calendar)) return { day0: nextTradingDay(local, calendar), timed: true };
  const session = sessionTimes(local, hours, calendar);
  if (session === null) return { day0: nextTradingDay(local, calendar), timed: true };
  const tradingEnd = session.close.getTime() - closeOffsetMin * MS_PER_MINUTE;
  return {
    day0: at.getTime() >= tradingEnd ? nextTradingDay(local, calendar) : local,
    timed: true,
  };
}

/** Abnormal return AR = r - b on close-to-close simple returns, exact; null when a base is not positive. */
export function abnormalReturn(
  close0: bigint,
  closePrev: bigint,
  index0: bigint,
  indexPrev: bigint,
): Rational | null {
  if (closePrev <= 0n || indexPrev <= 0n) return null;
  return subRat(
    makeRational(close0 - closePrev, closePrev),
    makeRational(index0 - indexPrev, indexPrev),
  );
}

const PPM = 1_000_000n; // threshold-ok: parts-per-million display unit

export type DayZeroMarket = {
  /** Adjusted-for-ex-date closes: the day-0 close and the previous close (same basis). */
  readonly close0: bigint;
  readonly closePrev: bigint;
  readonly index0: bigint;
  readonly indexPrev: bigint;
  /** Volumes oldest first, ending on day 0 (for the day-0 volume ratio). */
  readonly volumes: readonly bigint[];
};

/** Builds one event row (pure). `market` null = no day-0 bar yet / unavailable: AR and ratio NULL. */
export function buildEventRow(
  market: string,
  ann: Pick<
    AnnouncementRow,
    "source" | "ann_id" | "code" | "published_at" | "type" | "title" | "price_sensitive"
  >,
  day0: Day0,
  dayZero: DayZeroMarket | null,
  p: AgentParams,
): EventRow {
  const cls = classifyAnnouncement(ann.type, ann.title);
  const ar =
    dayZero === null
      ? null
      : abnormalReturn(dayZero.close0, dayZero.closePrev, dayZero.index0, dayZero.indexPrev);
  const ratio = dayZero === null ? null : volumeRatio(dayZero.volumes, p.windows.volumeRatio);
  return {
    market,
    source: ann.source,
    ann_id: ann.ann_id,
    code: ann.code,
    published_at: ann.published_at,
    timed: day0.timed ? 1 : 0,
    day0_d: day0.day0,
    group_key: `${ann.code}:${day0.day0}`,
    category: cls.category,
    price_sensitive: ann.price_sensitive,
    ar_ppm: ar === null ? null : Number(roundHalfAway(mulRat(ar, makeRational(PPM, 1n)))),
    ar_num: ar === null ? null : ar.num.toString(),
    ar_den: ar === null ? null : ar.den.toString(),
    vol_ratio_ppm:
      ratio === null ? null : Number(roundHalfAway(mulRat(ratio, makeRational(PPM, 1n)))),
    polarity: eventPolarity(cls.category, ar, p.eventPolarityThreshold),
    rule_version: EVENT_RULE_VERSION,
    category_llm: null,
    polarity_llm: null,
  };
}

/** The exact abnormal return of a stored row. */
export function arOf(row: Pick<EventRow, "ar_num" | "ar_den">): Rational | null {
  if (row.ar_num === null || row.ar_den === null) return null;
  return makeRational(BigInt(row.ar_num), BigInt(row.ar_den));
}

export type EventGroup = {
  readonly key: string;
  readonly code: string;
  readonly day0: string;
  /** Member announcement ids, `${source}|${ann_id}`, sorted. */
  readonly members: readonly string[];
};

/** Groups events by (code, day 0): "one event counts once" (F6 b) and one ledger row per group. */
export function groupEvents(rows: readonly EventRow[]): EventGroup[] {
  const byKey = new Map<string, EventRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.group_key);
    if (list === undefined) byKey.set(r.group_key, [r]);
    else list.push(r);
  }
  return [...byKey.keys()].sort().map((key) => {
    const list = byKey.get(key)!;
    return {
      key,
      code: list[0]!.code,
      day0: list[0]!.day0_d,
      members: list.map((r) => `${r.source}|${r.ann_id}`).sort(),
    };
  });
}

export type EventContext = {
  readonly params: AgentParams;
  readonly calendar: readonly CalendarRow[];
  readonly hours: MarketHours;
  readonly indexCode: string;
  /** Tracked codes (AGT-015); omitted = every code. */
  readonly codes?: readonly string[];
  readonly sinceIso?: string;
  /**
   * Exact split/consolidation factor to apply to the close BEFORE day 0 when day 0 is an ex-date
   * (DAT-126, ex-date <= D); null/absent = no adjustment.
   */
  readonly prevCloseFactor?: (code: string, day0: string) => Rational | null;
};

/**
 * Event rows for the decision of D (design 4.2 step 3): announcements published before cut-off(D)
 * not yet recorded whose day 0 <= D. Items whose day 0 is later wait for a later run; items with
 * no day-0 bar (halted, delisted) are recorded with AR and ratio NULL.
 */
export async function eventsForDecision(
  view: DecisionView,
  ctx: EventContext,
): Promise<EventRow[]> {
  const p = ctx.params;
  const recorded = await view.recordedEventKeys();
  const anns = await view.announcements({ codes: ctx.codes, sinceIso: ctx.sinceIso });
  const barCache = new Map<string, Awaited<ReturnType<DecisionView["bars"]>>>();
  const idxCache = new Map<string, Awaited<ReturnType<DecisionView["indexBars"]>>>();
  const need = p.windows.volumeRatio + 2;
  const out: EventRow[] = [];
  for (const a of [...anns].sort(byAnnouncement)) {
    if (recorded.has(`${a.source}|${a.ann_id}`)) continue;
    const day0 = day0Of(a.published_at, ctx.calendar, ctx.hours, p.windows.day0CloseOffsetMin);
    if (day0.day0 > view.guardD) continue;
    const bk = `${a.code}|${day0.day0}`;
    let bars = barCache.get(bk);
    if (bars === undefined) {
      bars = await view.bars(a.code, need, day0.day0);
      barCache.set(bk, bars);
    }
    let idx = idxCache.get(day0.day0);
    if (idx === undefined) {
      idx = await view.indexBars(ctx.indexCode, 2, day0.day0);
      idxCache.set(day0.day0, idx);
    }
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const i0 = idx[idx.length - 1];
    const iPrev = idx[idx.length - 2];
    let dayZero: DayZeroMarket | null = null;
    if (
      last !== undefined &&
      prev !== undefined &&
      last.d === day0.day0 &&
      i0 !== undefined &&
      iPrev !== undefined &&
      i0.d === day0.day0
    ) {
      const factor = ctx.prevCloseFactor?.(a.code, day0.day0) ?? null;
      const closePrev =
        factor === null ? prev.close : roundHalfAway(mulRat(makeRational(prev.close, 1n), factor));
      dayZero = {
        close0: last.close,
        closePrev,
        index0: i0.close,
        indexPrev: iPrev.close,
        volumes: bars.map((b) => b.volume),
      };
    }
    out.push(buildEventRow(view.market, a, day0, dayZero, p));
  }
  return out;
}

function byAnnouncement(a: AnnouncementRow, b: AnnouncementRow): number {
  if (a.published_at !== b.published_at) return a.published_at < b.published_at ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.ann_id < b.ann_id ? -1 : a.ann_id > b.ann_id ? 1 : 0;
}
