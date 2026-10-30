// Synthetic ZZ worlds for the C1c angle tests (M15; AT-50 pattern: ZZ codes, no real data). The
// long world has 1,300 weekday sessions from 2020-01-06 (one holiday, Australia Day 2020-01-27),
// five codes with closed-form closes so every expected value is computed in the test from the same
// formula, three sectors, ^AXJO / ^GSPC / ^VIX, a 10-year yield tied to ^AXJO, ASIC points, events
// with day-0 facts, two dividends and two index changes. `shortWorld` is a 300-session variant with
// a hand-written list of short-position reports.
import { defaultAgentParams } from "@/lib/agents/params";
import type { AgentParams } from "@/lib/agents/params";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { EventCategory, Polarity } from "@/lib/agents/schema";
import { AU_10Y_SERIES } from "@/lib/cortex/angles/d5";
import type { AsOfWorld, EventRow, MacroRow, ShortPoint } from "@/lib/cortex/pit/types";
import { calendarFor, CUTOFF_HHMM } from "../pit/zzWorld";

const M = 1_000_000n;
const CENT = 10_000n; // micro per cent

export const HOLIDAY = "2020-01-27";
export const LONG_CODES = ["ZZA", "ZZB", "ZZC", "ZZD", "ZZE"] as const;
export const SECTOR_OF: Readonly<Record<string, string>> = {
  ZZA: "Materials",
  ZZB: "Materials",
  ZZC: "Banks",
  ZZD: "Banks",
  ZZE: "Energy",
};

export function weekdaySessions(count: number, from = Date.UTC(2020, 0, 6)): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < count; i += 1) {
    const t = new Date(from + i * 86_400_000);
    const dow = t.getUTCDay();
    const d = t.toISOString().slice(0, 10);
    if (dow === 0 || dow === 6 || d === HOLIDAY) continue;
    out.push(d);
  }
  return out;
}

/** Close in cents of `code` at session index i (closed form, so tests recompute it). */
export function closeCents(code: string, i: number): number {
  switch (code) {
    case "ZZA":
      return 2000 + 10 * (i % 3); // periodic: zero return over any multiple of 3 sessions
    case "ZZB":
      return 500 + 20 * i; // linear rise
    case "ZZC":
      return 10_000 - 2 * i; // linear fall
    case "ZZD":
      return 30_000 + 30 * ((i * 7) % 11); // +-1 % wobble, period 11
    default:
      return 8000 + ((i * 13) % 17); // +-0.2 % wobble, period 17
  }
}

/** Volume at session i; ZZA surges on the last five sessions of a world of `n` sessions. */
export function volumeOf(code: string, i: number, n: number): bigint {
  if (code === "ZZA" && i >= n - 5) return 500_000n;
  return 100_000n + BigInt(i % 10) * 1_000n;
}

export function axjoLevel(i: number): number {
  return 7000 + 2 * i + 50 * ((i * 3) % 5);
}
export function gspcLevel(i: number): number {
  return 4000 + i;
}
export function vixLevel(i: number): number {
  return 10 + (i % 40);
}
/** The 10-year yield moves against ^AXJO (equities up, yields down: bonds and equities co-move). */
export function yieldAt(i: number): number {
  return 5 - 0.0001 * axjoLevel(i);
}

function barsOf(code: string, sessions: readonly string[]): ViewBar[] {
  const n = sessions.length;
  return sessions.map((d, i) => {
    const close = BigInt(closeCents(code, i)) * CENT;
    return {
      d,
      open: close - 5_000n,
      high: close + 20_000n,
      low: close - 20_000n,
      close,
      volume: volumeOf(code, i, n),
    };
  });
}

function indexOf(sessions: readonly string[], level: (i: number) => number): IndexViewBar[] {
  return sessions.map((d, i) => ({ d, close: BigInt(level(i)) * M }));
}

export function event(
  code: string,
  day0: string,
  over: Partial<EventRow> & { readonly category: EventCategory; readonly polarity: Polarity },
): EventRow {
  return {
    id: `asx|${code}-${day0}-${over.category}`,
    code,
    day0,
    groupKey: `${code}|${day0}|${over.category}`,
    priceSensitive: true,
    ar: null,
    volRatio: null,
    timed: true,
    day0LowMicro: null,
    publishedAt: `${day0}T00:30:00.000Z`,
    ...over,
  };
}

export type LongWorldOptions = {
  readonly sessions?: number;
  readonly macro?: ReadonlyMap<string, readonly MacroRow[]>;
  readonly shorts?: ReadonlyMap<string, readonly ShortPoint[]>;
};

/** Events of ZZA in a world of `n` sessions (see each test for the expected values they give). */
export function zzaEvents(sessions: readonly string[]): EventRow[] {
  const n = sessions.length;
  const at = (k: number) => sessions[n - k]!;
  return [
    // E1: results, PS, +1, AR +5 %, VR 3.5 (age 2 on the last session)
    event("ZZA", at(3), {
      category: "results",
      polarity: 1,
      ar: { num: 5n, den: 100n },
      volRatio: { num: 7n, den: 2n },
    }),
    // E2: director sale (age 9)
    event("ZZA", at(10), { category: "director_trade", polarity: -1, priceSensitive: false }),
    // E3: substantial holder increase (age 14)
    event("ZZA", at(15), { category: "substantial_holder", polarity: 1, priceSensitive: false }),
    // E4: guidance down (age 39)
    event("ZZA", at(40), { category: "guidance_down", polarity: -1 }),
    // E5: guidance up (age 99)
    event("ZZA", at(100), { category: "guidance_up", polarity: 1 }),
    // E6: other, not price-sensitive, no day-0 facts (age 1)
    event("ZZA", at(2), { category: "other", polarity: 0, priceSensitive: false }),
    // E7: capital raising, PS, -1, AR -3 %, VR 2 (age 0)
    event("ZZA", at(1), {
      category: "capital_raising",
      polarity: -1,
      ar: { num: -3n, den: 100n },
      volRatio: { num: 2n, den: 1n },
    }),
  ];
}

export function longWorld(opts: LongWorldOptions = {}): AsOfWorld {
  const sessions = weekdaySessions(opts.sessions ?? 1300);
  const n = sessions.length;
  const last = sessions[n - 1]!;
  const params: AgentParams = defaultAgentParams();
  const macro: ReadonlyMap<string, readonly MacroRow[]> =
    opts.macro ??
    new Map([[AU_10Y_SERIES, sessions.map((d, i) => ({ obsD: d, value: yieldAt(i) }))]]);
  const dividends: CorpActionRecord[] = [
    {
      id: "ca-zza-div-1",
      code: "ZZA",
      type: "cash_dividend",
      exDate: sessions[n - 100]!,
      payload: { dps: "0.30" },
      knownAt: null,
    },
    {
      id: "ca-zza-div-2",
      code: "ZZA",
      type: "cash_dividend",
      exDate: last,
      payload: { dps: "0.10" },
      knownAt: null,
    },
  ];
  return {
    market: "AU",
    sessions,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(sessions, [HOLIDAY]),
    schemaSha: "schema-zz-c1c",
    bars: new Map(LONG_CODES.map((c) => [c, barsOf(c, sessions)])),
    tiers: new Map(LONG_CODES.map((c) => [c, [{ d: sessions[0]!, tier: "U1" as const }]])),
    index: {
      AXJO: indexOf(sessions, axjoLevel),
      GSPC: indexOf(sessions, gspcLevel),
      VIX: indexOf(sessions, vixLevel),
    },
    shorts: opts.shorts ?? new Map(),
    macro,
    events: new Map([["ZZA", zzaEvents(sessions)]]),
    corpActions: new Map([["ZZA", dividends]]),
    indexChanges: new Map([
      // ZZB: add announced five sessions before the end, effective after the calendar ends.
      [
        "ZZB",
        [
          {
            indexName: "ZZ200",
            kind: "add" as const,
            announced: sessions[n - 5]!,
            effective: "2030-01-01",
          },
        ],
      ],
      // ZZC: delete announced eight sessions before the end (T - 7), effective the session before the last (T - 1).
      [
        "ZZC",
        [
          {
            indexName: "ZZ200",
            kind: "delete" as const,
            announced: sessions[n - 8]!,
            effective: sessions[n - 2]!,
          },
        ],
      ],
    ]),
    industry: new Map(
      LONG_CODES.map((c) => [c, [{ asOf: sessions[0]!, industry: SECTOR_OF[c]! }]]),
    ),
    regimeParams: params,
  };
}

/** Twelve ASIC reports for ZZA at sessions 200, 205, ... 255 of a 300-session world. */
export const SHORT_PPM = [5, 3, 8, 1, 9, 2, 7, 4, 6, 10, 12, 11].map((k) => k * 1000);

export function shortWorld(): AsOfWorld {
  const sessions = weekdaySessions(300);
  const points: ShortPoint[] = SHORT_PPM.map((ppm, j) => ({ asOf: sessions[200 + 5 * j]!, ppm }));
  return longWorld({ sessions: 300, shorts: new Map([["ZZA", points]]) });
}
