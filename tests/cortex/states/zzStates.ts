// Synthetic ZZ worlds for the C3b state-machine tests (AT-56 fixtures on ZZ codes, no real data).
// Forty weekday sessions from 2026-02-02; one code per fixture with a scripted raw close path (in
// cents), optional volumes, opens, halts, corporate actions and events; a flat-ish ^AXJO so the
// abnormal-return proxy equals the raw return.
import { defaultAgentParams } from "@/lib/agents/params";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { EventCategory, Polarity } from "@/lib/agents/schema";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { CalendarRow } from "@/lib/data/calendar";
import type { AsOfWorld, EventRow, HaltRow, TierRow } from "@/lib/cortex/pit/types";
import type {
  CandidateSource,
  CorpActionStatus,
  CortexCorpAction,
} from "@/lib/cortex/states/types";
import type { Tier } from "@/lib/agents/families/types";
import { makeRational, type Rational } from "@/lib/money/rational";

export const CUTOFF_HHMM = "18:10";

export function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; out.length < n; i += 1) {
    const t = new Date(start + i * 86_400_000);
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}

export const SESSIONS: readonly string[] = weekdays("2026-02-02", 40);

export const CENT = 10_000n; // micro per cent

export type BarScript = {
  /** Raw close per session in cents; a null entry = no bar (halted). */
  readonly closesCents: readonly (number | null)[];
  /** Volume per session (shares); default 100 000. */
  readonly volumes?: readonly bigint[];
  /** Open per session in cents; default = the close. */
  readonly opensCents?: readonly (number | null)[];
};

export function scriptBars(script: BarScript, sessions: readonly string[] = SESSIONS): ViewBar[] {
  const out: ViewBar[] = [];
  sessions.forEach((d, i) => {
    const c = script.closesCents[i];
    if (c === null || c === undefined) return;
    const close = BigInt(Math.round(c * 100)) * 100n; // cents with 2 decimals -> micro
    const o = script.opensCents?.[i];
    const open = o === null || o === undefined ? close : BigInt(Math.round(o * 100)) * 100n;
    const hi = open > close ? open : close;
    const lo = open < close ? open : close;
    out.push({
      d,
      open,
      high: hi + CENT,
      low: lo - CENT,
      close,
      volume: script.volumes?.[i] ?? 100_000n,
    });
  });
  return out;
}

/** A path: `base` cents for `n` sessions, then the given multiplicative moves applied one per session, then flat. */
export function path(
  base: number,
  n: number,
  moves: readonly number[],
  total = SESSIONS.length,
): number[] {
  const out: number[] = [];
  let level = base;
  for (let i = 0; i < total; i += 1) {
    if (i >= n && i - n < moves.length) level = level * (1 + moves[i - n]!);
    out.push(Math.round(level * 100) / 100);
  }
  return out;
}

export function flatIndex(sessions: readonly string[] = SESSIONS): IndexViewBar[] {
  return sessions.map((d) => ({ d, close: 7_000n * 1_000_000n }));
}

export function calendarFor(sessions: readonly string[]): CalendarRow[] {
  return sessions.map((d): CalendarRow => ({ d, kind: "session", close_time: null, confirmed: 1 }));
}

export function tierRows(d: string, tier: Tier): TierRow[] {
  return [{ d, tier }];
}

/**
 * A corporate action with its provenance riding on the record (`CortexCorpAction`, D-321), known
 * at 16:00 Melbourne (05:00Z) of `knownD`. Default: a pending ASX notice. `sources: null` builds a
 * record with no provenance at all (what `loadConfirmedActions` yields today).
 */
export function noticeAction(
  code: string,
  type: string,
  exDate: string,
  payload: Record<string, unknown>,
  knownD: string,
  sources: readonly CandidateSource[] | null = ["announcement"],
  status: CorpActionStatus = "pending",
  id = `ca-${code}-${type}-${exDate}-${sources === null ? "nosrc" : sources.join("+")}-${status}`,
): CorpActionRecord {
  const base: CorpActionRecord = {
    id,
    code,
    type,
    exDate,
    payload,
    knownAt: `${knownD}T05:00:00.000Z`,
  };
  if (sources === null) return base;
  const withProvenance: CortexCorpAction = { ...base, sources, status };
  return withProvenance;
}

export function eventAt(
  code: string,
  day0: string,
  category: EventCategory,
  polarity: Polarity,
  ar: Rational | null,
  extra: Partial<EventRow> = {},
): EventRow {
  return {
    id: `asx|${code}-${day0}-${category}`,
    code,
    day0,
    groupKey: `${code}|${day0}`,
    category,
    priceSensitive: true,
    polarity,
    ar,
    volRatio: null,
    timed: true,
    day0LowMicro: null,
    publishedAt: `${day0}T00:30:00.000Z`,
    ...extra,
  };
}

export const pct = (p: number): Rational => makeRational(BigInt(Math.round(p * 1000)), 100_000n);

export type FixtureSpec = {
  readonly code: string;
  readonly tier: Tier;
  readonly bars: BarScript;
  readonly corpActions?: readonly CorpActionRecord[];
  readonly events?: readonly EventRow[];
  readonly halts?: readonly HaltRow[];
};

/** One ZZ world holding the given fixtures (one code each). */
export function statesWorld(
  fixtures: readonly FixtureSpec[],
  overrides: Partial<AsOfWorld> = {},
): AsOfWorld {
  return {
    market: "AU",
    sessions: SESSIONS,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(SESSIONS),
    schemaSha: "schema-zz-states",
    bars: new Map(fixtures.map((f) => [f.code, scriptBars(f.bars)])),
    tiers: new Map(fixtures.map((f) => [f.code, tierRows(SESSIONS[0]!, f.tier)])),
    index: { AXJO: flatIndex() },
    corpActions: new Map(
      fixtures.filter((f) => f.corpActions).map((f) => [f.code, f.corpActions!]),
    ),
    events: new Map(fixtures.filter((f) => f.events).map((f) => [f.code, f.events!])),
    halts: new Map(fixtures.filter((f) => f.halts).map((f) => [f.code, f.halts!])),
    indexChanges: new Map(),
    regimeParams: defaultAgentParams(),
    ...overrides,
  };
}
