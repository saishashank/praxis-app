// Thesis-breaker evaluator (M5 T7; AGT-110, AGT-111; docs/M5_design.md 2.5, 4.4; D-085, D-089,
// D-096 #15, #16, #39; D-102 draft). PURE: a card's breaker list plus one observation of the code
// give a status per breaker (green / amber / red) and the worst of them for the position. The
// nightly batch 2b, the Sentinel's intraday path and the in-memory replay all call these functions,
// so replay == live. No clock, no random source, no I/O; every threshold is an AgentParams value or
// a number the card stored (the amber level, decision 15: kept as written on the card).
//
//   red    the condition holds
//   amber  a continuous breaker (TB-EVLOW, TB-SI, TB-SMA) has only `thesis_amber_fraction` of the
//          distance to its trigger left (the card's amber level where it stored one), or a keyword
//          breaker (TB-KW) waits for confirmation
//   green  otherwise
// Event breakers TB-NEG / TB-HALT / TB-RAISE / TB-REGIME are green or red only.
//
// TB-KW (decision 16): the night a title keyword is first seen it is amber (`awaiting_confirmation`).
// From `tb_kw_confirm_sessions` sessions later it is red when the same announcement's A2 category
// (guidance-down, halt/suspension) or ASX type code confirms it, else green with the reason
// `unconfirmed`. Confirmation is automatic and deterministic; nobody is asked.
import type { Client } from "@libsql/client";
import {
  cmpRat,
  makeRational,
  mulRat,
  ratFromInt,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import type { ViewBar } from "./decisionView";
import { classifyAnnouncement, eventPolarity } from "./events";
import type { EventFact } from "./families/types";
import { smaExact } from "./indicators";
import type { AgentParams } from "./params";
import { roundHalfAway } from "./regime";
import type { EventCategory, Polarity } from "./schema";
import { amberLevelMicro, type BreakerId, type CardBreaker } from "./thesisBreakers";

export const BREAKER_EVAL_RULE_VERSION = "tb-v1";

export type BreakerStatus = "green" | "amber" | "red";
export type BreakerPhase = "nightly" | "preopen" | "intraday";

/** The breakers a Sentinel assessment can move between two nights (design 4.4 step 2). */
export const INTRADAY_BREAKERS: readonly BreakerId[] = ["TB-NEG", "TB-HALT", "TB-RAISE", "TB-KW"];

/** ASX type codes that confirm a keyword match by themselves (lower case, exact). */
export const KW_CONFIRMING_TYPES: readonly string[] = [
  "trading halt",
  "suspension from quotation",
  "guidance withdrawn",
];

/** A2 categories that confirm a keyword match. */
export const KW_CONFIRMING_CATEGORIES: readonly EventCategory[] = [
  "guidance_down",
  "halt_suspension",
];

const PPM_PER_PP = 10_000n; // threshold-ok: one percentage point is 10,000 ppm (as shortInterest.ts)

/** One announcement seen after the card's decision, with the facts the breakers read. */
export type BreakerItem = {
  /** `${source}|${ann_id}`. */
  readonly ref: string;
  /** Sessions from the item's day 0 to the evaluation session (0 = day 0 is the session itself). */
  readonly ageSessions: number;
  readonly category: EventCategory;
  readonly priceSensitive: boolean;
  readonly polarity: Polarity;
  /** Lower-case title and ASX type; null when the source carries no text (replay snapshots). */
  readonly title: string | null;
  readonly type: string | null;
};

export type BreakerObservation = {
  readonly d: string;
  readonly phase: BreakerPhase;
  /** Close of D on the card's price basis (raw micro); null = no bar. */
  readonly closeMicro: bigint | null;
  /** SMA(`sma_trend_period`) of the raw closes through D; null in warm-up. */
  readonly smaMicro: bigint | null;
  /** Close on the card's own day: the SMA amber level is measured from it. */
  readonly refCloseMicro: bigint | null;
  /** Short-interest change over the window in ppm (latest minus prior); null = unknown. */
  readonly shortDeltaPpm: number | null;
  /** Regime label of D; null = not computed. */
  readonly regime: string | null;
  readonly items: readonly BreakerItem[];
};

export type BreakerEvaluation = {
  readonly id: BreakerId;
  readonly status: BreakerStatus;
  readonly valueText: string;
  readonly triggerText: string;
  readonly amberText: string | null;
  /** `${source}|${ann_id}` of the announcement that moved the status; null for market data. */
  readonly triggerRef: string | null;
};

export type PositionEvaluation = {
  readonly evaluations: readonly BreakerEvaluation[];
  /** Worst status of the list (decision 15); green for an empty list. */
  readonly status: BreakerStatus;
  /** Red breaker ids in card order. */
  readonly red: readonly BreakerId[];
};

const RANK: Record<BreakerStatus, number> = { green: 0, amber: 1, red: 2 };

export function worstStatus(list: readonly BreakerStatus[]): BreakerStatus {
  let worst: BreakerStatus = "green";
  for (const s of list) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function micro(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return null;
}

function ratOf(text: unknown): Rational | null {
  if (typeof text !== "string") return null;
  const m = /^(-?\d+)\/(\d+)$/.exec(text);
  if (m === null || BigInt(m[2]!) === 0n) return null;
  return makeRational(BigInt(m[1]!), BigInt(m[2]!));
}

const first = (items: readonly BreakerItem[]): BreakerItem | undefined =>
  [...items].sort((a, b) => cmpText(a.ref, b.ref))[0];

function eventOnly(
  b: CardBreaker,
  hits: readonly BreakerItem[],
  trigger: string,
): BreakerEvaluation {
  const hit = first(hits);
  return {
    id: b.id,
    status: hit === undefined ? "green" : "red",
    valueText: hit === undefined ? "none" : `${hit.category} ${hit.ref}`,
    triggerText: trigger,
    amberText: null,
    triggerRef: hit === undefined ? null : hit.ref,
  };
}

function keywordHit(item: BreakerItem, keywords: readonly string[]): boolean {
  if (item.title === null) return false;
  const title = item.title;
  return keywords.some((k) => title.includes(k.toLowerCase()));
}

function confirms(item: BreakerItem): boolean {
  return (
    KW_CONFIRMING_CATEGORIES.includes(item.category) ||
    (item.type !== null && KW_CONFIRMING_TYPES.includes(item.type))
  );
}

function evaluateKeyword(
  b: CardBreaker,
  obs: BreakerObservation,
  p: AgentParams,
): BreakerEvaluation {
  const keywords = Array.isArray(b.keywords) ? (b.keywords as readonly string[]) : [];
  const hits = obs.items.filter((i) => keywordHit(i, keywords));
  const base = { id: b.id, triggerText: keywords.join("|"), amberText: "awaiting_confirmation" };
  const red = first(hits.filter((i) => i.ageSessions >= p.tbKwConfirmSessions && confirms(i)));
  if (red !== undefined) {
    return { ...base, status: "red", valueText: `confirmed ${red.ref}`, triggerRef: red.ref };
  }
  const waiting = first(hits.filter((i) => i.ageSessions < p.tbKwConfirmSessions));
  if (waiting !== undefined) {
    return {
      ...base,
      status: "amber",
      valueText: `awaiting_confirmation ${waiting.ref}`,
      triggerRef: waiting.ref,
    };
  }
  const expired = first(hits);
  return {
    ...base,
    status: "green",
    valueText: expired === undefined ? "none" : `unconfirmed ${expired.ref}`,
    triggerRef: null,
  };
}

function evaluateBelow(
  b: CardBreaker,
  close: bigint | null,
  level: bigint | null,
  amberAt: bigint | null,
  what: string,
): BreakerEvaluation {
  const amberText = amberAt === null ? null : amberAt.toString();
  if (close === null || level === null) {
    return {
      id: b.id,
      status: "green",
      valueText: close === null ? "no_bar" : "no_level",
      triggerText: level === null ? what : `${what} < ${level}`,
      amberText,
      triggerRef: null,
    };
  }
  const status: BreakerStatus =
    close < level ? "red" : amberAt !== null && close <= amberAt ? "amber" : "green";
  return {
    id: b.id,
    status,
    valueText: close.toString(),
    triggerText: `${what} < ${level}`,
    amberText,
    triggerRef: null,
  };
}

/** One breaker of a card against one observation. Never throws for missing data (green, with the reason). */
export function evaluateBreaker(
  b: CardBreaker,
  obs: BreakerObservation,
  p: AgentParams,
): BreakerEvaluation {
  switch (b.id) {
    case "TB-NEG":
      return eventOnly(
        b,
        obs.items.filter((i) => i.priceSensitive && i.polarity === -1),
        "price_sensitive_negative",
      );
    case "TB-HALT":
      return eventOnly(
        b,
        obs.items.filter(
          (i) => i.category === "halt_suspension" || i.category === "exchange_query",
        ),
        "halt_suspension_or_query",
      );
    case "TB-RAISE":
      return eventOnly(
        b,
        obs.items.filter((i) => i.category === "capital_raising"),
        "capital_raising",
      );
    case "TB-KW":
      return evaluateKeyword(b, obs, p);
    case "TB-REGIME": {
      const states = Array.isArray(b.states) ? (b.states as readonly string[]) : [];
      const hit = obs.regime !== null && states.includes(obs.regime);
      return {
        id: b.id,
        status: hit ? "red" : "green",
        valueText: obs.regime ?? "unknown",
        triggerText: states.join("|"),
        amberText: null,
        triggerRef: null,
      };
    }
    case "TB-EVLOW":
      return evaluateBelow(
        b,
        obs.closeMicro,
        micro(b.level_micro),
        micro(b.amber_at_micro),
        "close",
      );
    case "TB-SMA": {
      const sma = obs.smaMicro;
      const ref = obs.refCloseMicro;
      const amberAt =
        sma === null || ref === null ? null : amberLevelMicro(ref, sma, p.thesisAmberFraction);
      return evaluateBelow(b, obs.closeMicro, sma, amberAt, "close_vs_sma");
    }
    case "TB-SI": {
      const rise = ratOf(b.rise_pp) ?? p.f6.shortDropPp;
      const trigger = mulRat(rise, makeRational(PPM_PER_PP, 1n));
      const amber = mulRat(trigger, subRat(ratFromInt(1n), p.thesisAmberFraction));
      const base = {
        id: b.id,
        triggerText: `rise >= ${roundHalfAway(trigger)} ppm`,
        amberText: roundHalfAway(amber).toString(),
        triggerRef: null,
      };
      if (obs.shortDeltaPpm === null) return { ...base, status: "green", valueText: "unknown" };
      const delta = ratFromInt(BigInt(obs.shortDeltaPpm));
      const status: BreakerStatus =
        cmpRat(delta, trigger) >= 0 ? "red" : cmpRat(delta, amber) >= 0 ? "amber" : "green";
      return { ...base, status, valueText: `${obs.shortDeltaPpm} ppm` };
    }
  }
}

/** All breakers of a card (or only the intraday-capable ones in the intraday phase). */
export function evaluateBreakers(
  breakers: readonly CardBreaker[],
  obs: BreakerObservation,
  p: AgentParams,
): PositionEvaluation {
  const list =
    obs.phase === "intraday" ? breakers.filter((b) => INTRADAY_BREAKERS.includes(b.id)) : breakers;
  const evaluations = list.map((b) => evaluateBreaker(b, obs, p));
  return {
    evaluations,
    status: worstStatus(evaluations.map((e) => e.status)),
    red: evaluations.filter((e) => e.status === "red").map((e) => e.id),
  };
}

// ---- observations (shared by the nightly batch, the Sentinel and the replay) --------------------------------------

export type AnnouncementText = { readonly title: string | null; readonly type: string | null };

/** Items from A2 event facts; `texts` (by ref) adds the title and type where the source has them. */
export function itemsFromEvents(
  events: readonly EventFact[],
  sessions: readonly string[],
  d: string,
  texts: ReadonlyMap<string, AnnouncementText> = new Map(),
): BreakerItem[] {
  return events
    .filter((e) => e.day0 <= d)
    .map((e) => {
      const t = texts.get(e.id);
      return {
        ref: e.id,
        ageSessions: sessions.filter((s) => s > e.day0 && s <= d).length,
        category: e.category,
        priceSensitive: e.priceSensitive,
        polarity: e.polarity,
        title: t?.title === null || t?.title === undefined ? null : t.title.toLowerCase(),
        type: t?.type === null || t?.type === undefined ? null : t.type.trim().toLowerCase(),
      };
    })
    .sort((a, b) => cmpText(a.ref, b.ref));
}

/** An item from one raw announcement (Sentinel, before any A2 row exists); age 0. Pure rule table. */
export function itemFromAnnouncement(a: {
  readonly ref: string;
  readonly type: string | null;
  readonly title: string;
  readonly priceSensitive: boolean;
}): BreakerItem {
  const c = classifyAnnouncement(a.type, a.title);
  return {
    ref: a.ref,
    ageSessions: 0,
    category: c.category,
    priceSensitive: a.priceSensitive,
    polarity: eventPolarity(c.category, null, ratFromInt(0n)),
    title: a.title.toLowerCase(),
    type: a.type === null ? null : a.type.trim().toLowerCase(),
  };
}

export type ObservationInput = {
  readonly d: string;
  readonly phase: BreakerPhase;
  /** Raw bars of the code, oldest first, last = D (at least `sma_trend_period` for the SMA). */
  readonly rawBars: readonly ViewBar[];
  readonly refCloseMicro: bigint | null;
  readonly shortDeltaPpm: number | null;
  readonly regime: string | null;
  readonly items: readonly BreakerItem[];
};

export function buildObservation(i: ObservationInput, p: AgentParams): BreakerObservation {
  const last = i.rawBars[i.rawBars.length - 1];
  const closeMicro = last !== undefined && last.d === i.d ? last.close : null;
  const sma = smaExact(
    i.rawBars.map((b) => b.close),
    p.windows.smaTrend,
  );
  return {
    d: i.d,
    phase: i.phase,
    closeMicro,
    smaMicro: sma === null ? null : roundHalfAway(sma),
    refCloseMicro: i.refCloseMicro,
    shortDeltaPpm: i.shortDeltaPpm,
    regime: i.regime,
    items: i.items,
  };
}

/** Day-0 low of the signal's event group, the TB-EVLOW level the card stores (null = none). */
export function eventLowOf(events: readonly EventFact[], groupKey: string | null): bigint | null {
  if (groupKey === null) return null;
  return (
    events.find((e) => e.groupKey === groupKey && e.day0LowMicro !== null)?.day0LowMicro ?? null
  );
}

// ---- alerts: the seam T6 implements ------------------------------------------------------------------------------

/** A red breaker (or an intraday hit) as the alert path needs it. */
export type BreakerAlert = {
  /** `tb:<subject>:<breaker>:<d>` (design 2.2). */
  readonly key: string;
  readonly market: string;
  readonly code: string;
  readonly d: string;
  readonly phase: BreakerPhase;
  readonly subjectKind: "trade" | "order";
  readonly subjectId: string;
  readonly cardId: string;
  readonly executionId: string | null;
  readonly breakerId: BreakerId;
  readonly status: BreakerStatus;
  readonly valueText: string;
  readonly triggerText: string;
  readonly triggerRef: string | null;
  /** `exit_queued` = batch 2b created the exit; `none` = the intraday path only reports (AGT-012). */
  readonly effect: "exit_queued" | "none";
  readonly detectedAt: string;
};

/** T6's alert writer implements this; breakers only call it for a red status. Must be idempotent on `key`. */
export interface BreakerAlertSink {
  record(alert: BreakerAlert): Promise<void>;
}

/**
 * Default sink: writes the `alert` row of design 2.2 (kind thesis_breaker, `INSERT ... ON CONFLICT DO
 * NOTHING`, tier P1 for a held position, P2 for a pending order) when the table exists; a missing
 * table or any write failure is swallowed, because an alert must never fail an evaluation.
 */
export function createAlertRowSink(db: Pick<Client, "execute">): BreakerAlertSink {
  return {
    async record(a) {
      try {
        await db.execute({
          sql: `INSERT INTO alert (alert_key, market, code, kind, tier, execution_id, published_at,
                  detected_at, facts_json)
                VALUES (?, ?, ?, 'thesis_breaker', ?, ?, NULL, ?, ?) ON CONFLICT DO NOTHING`,
          args: [
            a.key,
            a.market,
            a.code,
            a.subjectKind === "trade" ? "P1" : "P2",
            a.executionId,
            a.detectedAt,
            JSON.stringify({
              breaker: a.breakerId,
              card: a.cardId,
              d: a.d,
              effect: a.effect,
              phase: a.phase,
              status: a.status,
              subject: a.subjectId,
              subject_kind: a.subjectKind,
              trigger: a.triggerText,
              trigger_ref: a.triggerRef,
              value: a.valueText,
            }),
          ],
        });
      } catch {
        // no alert table yet (before migration 0009) or a rejected row: the evaluation stands
      }
    },
  };
}
