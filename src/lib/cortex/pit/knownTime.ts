// Known-time rules, one per InputKind (CTX-010; docs/M15_design.md 3a, 6; D-263, D-290, D-291).
// A row becomes usable for the decision of session D when its known time <= cutoffUtc(D). The rule
// is data in this table, never a branch in an angle, and the same table serves the live night, the
// replay and the offline extract (D-278). Pure: no clock, no I/O; every instant comes from the row
// or the session list. Instants are compared parsed (Date.parse), never as text.
//
// "+1 session" rules return the first instant of the next session date (T00:00:00Z): a row then
// counts at that session's cut-off and not at the previous one (00:00Z of a Melbourne date is
// 10:00 / 11:00 local, hours before the 18:10 cut-off and hours after the previous day's).
import { AU_TIME_ZONE, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { asicPublishedAt } from "@/lib/data/backfill/rules.mjs";
import { addDays, localToUtc } from "@/lib/data/calendar";
import type { InputKind, KnownTimeRow, KnownTimeRule, SessionClock } from "./types";

/** Known since before any session: calendar rows and actions that predate the known_at column. */
export const ALWAYS_KNOWN = "1970-01-01T00:00:00.000Z";
/** Never usable inside this world: a "+n sessions" rule that runs past the end of the session list. */
export const NEVER_KNOWN = "9999-12-31T23:59:59.000Z";

/** Local wall time at which US index bars dated D are assumed known (D+1, all year; CTX-010). */
export const INDEX_US_KNOWN_LOCAL = "09:00";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(text: string): boolean {
  return DATE_RE.test(text);
}

/** The first instant of a session date, ISO UTC. */
export function dayStartUtc(d: string): string {
  if (!isDateOnly(d)) throw new RangeError(`not a date: ${d}`);
  return `${d}T00:00:00.000Z`;
}

/** ISO text -> epoch ms; throws on anything Date.parse cannot read, so a bad stamp never passes as "known". */
export function instantMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`not an instant: ${iso}`);
  return ms;
}

function lowerBound(sessions: readonly string[], d: string): number {
  let lo = 0;
  let hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid]! < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The session arithmetic the rules need; `sessions` must be strictly increasing date strings. */
export function makeSessionClock(sessions: readonly string[], cutoffHhmm: string): SessionClock {
  for (let i = 0; i < sessions.length; i += 1) {
    const s = sessions[i]!;
    if (!isDateOnly(s)) throw new RangeError(`session ${i} is not a date: ${s}`);
    if (i > 0 && !(sessions[i - 1]! < s)) throw new RangeError(`sessions not increasing at ${i}`);
  }
  const cache = new Map<string, string>();
  return {
    sessions,
    cutoffHhmm,
    cutoffUtc(d) {
      let v = cache.get(d);
      if (v === undefined) {
        v = decisionCutoffUtc(d, cutoffHhmm);
        cache.set(d, v);
      }
      return v;
    },
    nextSession(d) {
      const i = lowerBound(sessions, d);
      const j = i < sessions.length && sessions[i] === d ? i + 1 : i;
      return j < sessions.length ? sessions[j]! : null;
    },
    previousSession(d) {
      const i = lowerBound(sessions, d);
      return i > 0 ? sessions[i - 1]! : null;
    },
  };
}

/** The n-th session after `d` as a known instant, or NEVER_KNOWN past the end of the list. */
export function sessionsAfterUtc(clock: SessionClock, d: string, n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`bad session lag ${n}`);
  if (n === 0) return dayStartUtc(d);
  let cur: string | null = d;
  for (let i = 0; i < n && cur !== null; i += 1) cur = clock.nextSession(cur);
  return cur === null ? NEVER_KNOWN : dayStartUtc(cur);
}

// ---- macro series ------------------------------------------------------------------------------------------------

/**
 * Publication rule of a macro series (design 6): the RBA cash-rate decision is published on the
 * decision day at 14:30 Melbourne; RBA F-table and FRED daily series the next session; FRED monthly
 * series carry a conservative lag from their observation date (the first of the month) that is
 * later than the real release, so a row can never be seen early [VERIFY against release calendars].
 * Any series not listed falls to `MACRO_DEFAULT` (= the untimed rule, +1 session). Revisions are not
 * modelled (no ALFRED vintages in the extract): stated in the passport history fields.
 */
export type MacroPublishRule =
  | { readonly kind: "same_day"; readonly localTime: string }
  | { readonly kind: "sessions"; readonly lag: number };

export const MACRO_DEFAULT: MacroPublishRule = { kind: "sessions", lag: 1 };

export const MACRO_SERIES: Readonly<Record<string, MacroPublishRule>> = {
  RBA_CASH_RATE: { kind: "same_day", localTime: "14:30" },
  RBA_F1: MACRO_DEFAULT,
  DGS2: MACRO_DEFAULT,
  DGS10: MACRO_DEFAULT,
  T10Y2Y: MACRO_DEFAULT,
  DTWEXBGS: MACRO_DEFAULT,
  FEDFUNDS: { kind: "sessions", lag: 25 }, // threshold-ok: released the first business day of the next month
  CPIAUCSL: { kind: "sessions", lag: 35 }, // threshold-ok: released about two weeks into the next month
};

export function macroRuleFor(series: string | undefined): MacroPublishRule {
  return (series !== undefined && MACRO_SERIES[series]) || MACRO_DEFAULT;
}

// ---- the table -------------------------------------------------------------------------------------------------

function need(value: string | null | undefined, what: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new RangeError(`known-time rule needs ${what}`);
  return value;
}

function instantText(iso: string): string {
  return new Date(instantMs(iso)).toISOString();
}

const barAtCutoff: KnownTimeRule = (row, clock) => clock.cutoffUtc(need(row.d, "d"));

export const KNOWN_TIME: Readonly<Record<InputKind, KnownTimeRule>> = {
  // D-263 interim: a D bar present in the night's snapshot is known at the cut-off of D; the p95
  // latency measured on staging replaces this once recorded (same rule live and in replay).
  bar_au: barAtCutoff,
  index_au: barAtCutoff,
  // US session D closes after the Melbourne cut-off of D: known D+1 09:00 Melbourne all year (D-290).
  index_us: (row) =>
    localToUtc(addDays(need(row.d, "d"), 1), INDEX_US_KNOWN_LOCAL, AU_TIME_ZONE).toISOString(),
  // ASIC publishes with a lag: asicPublishedAt = as_of + ASIC_PUBLISH_LAG_WEEKDAYS weekdays, end of day.
  asic_short: (row) => asicPublishedAt(need(row.asOf, "asOf")),
  // A stamped publication wins; otherwise the series rule from the observation date.
  macro: (row, clock) => {
    if (typeof row.publishedAt === "string" && row.publishedAt.length > 0)
      return instantText(row.publishedAt);
    const d = need(row.d, "d");
    const rule = macroRuleFor(row.series);
    if (rule.kind === "same_day") return localToUtc(d, rule.localTime, AU_TIME_ZONE).toISOString();
    return sessionsAfterUtc(clock, d, rule.lag);
  },
  // Platform publication time; an untimed backfill row (date-only) = announcement date + 1 session (OI-46).
  announcement: (row, clock) => {
    const p = need(row.publishedAt, "publishedAt");
    return isDateOnly(p) ? sessionsAfterUtc(clock, p, 1) : instantText(p);
  },
  // GL-02 known_at when confirmed; a vendor row without one is assumed known the session before its ex-date.
  corp_action: (row, clock) => {
    if (typeof row.knownAt === "string" && row.knownAt.length > 0) return instantText(row.knownAt);
    const prev = clock.previousSession(need(row.exDate, "exDate"));
    return prev === null ? ALWAYS_KNOWN : dayStartUtc(prev);
  },
  // The manual DAT-234 list: a stamp when the row has one, else the announced date + 1 session
  // (the effective date when no announcement date is recorded; row.d carries that date): the CSV
  // has no publication time, so it is treated as an untimed row (D-302, same as OI-46).
  index_change: (row, clock) => {
    if (typeof row.knownAt === "string" && row.knownAt.length > 0) return instantText(row.knownAt);
    return sessionsAfterUtc(clock, need(row.d, "d"), 1);
  },
  calendar: () => ALWAYS_KNOWN,
  // The instrument-class list is dated by its as_of; usable from that day's cut-off.
  sector_map: (row) => dayStartUtc(need(row.asOf, "asOf")),
};

export function knownTimeOf(kind: InputKind, row: KnownTimeRow, clock: SessionClock): string {
  return KNOWN_TIME[kind](row, clock);
}

/** True when the row's known time is at or before the cut-off instant (parsed, not text-compared). */
export function isKnownBy(
  kind: InputKind,
  row: KnownTimeRow,
  clock: SessionClock,
  cutoffIso: string,
): boolean {
  return instantMs(knownTimeOf(kind, row, clock)) <= instantMs(cutoffIso);
}
