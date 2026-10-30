// Synthetic ZZ world for the C1a point-in-time tests (M15; AT-50 pattern: ZZ codes, no real data).
// Twelve March 2026 sessions with a holiday on the 9th, three codes, one split, one dividend, an
// ASIC point, two macro series, a timed and an untimed event, an index change, an industry row and
// a halt. Every stamp is chosen so that at least one session sees the row and one does not.
import { defaultAgentParams } from "@/lib/agents/params";
import type { AgentParams } from "@/lib/agents/params";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import type { CalendarRow } from "@/lib/data/calendar";
import type { AsOfWorld, EventRow } from "@/lib/cortex/pit/types";

export const SESSIONS: readonly string[] = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-10",
  "2026-03-11",
  "2026-03-12",
  "2026-03-13",
  "2026-03-16",
  "2026-03-17",
  "2026-03-18",
];
export const HOLIDAY = "2026-03-09";
export const CUTOFF_HHMM = "18:10";
export const CODES = ["ZZA", "ZZB", "ZZC"] as const;

const M = 1_000_000n;

/** Deterministic bars: close drifts up by 1 % a session from a per-code base; high/low bracket it. */
export function barsFor(code: string, sessions: readonly string[] = SESSIONS): ViewBar[] {
  const base = code === "ZZA" ? 2_000n : code === "ZZB" ? 500n : 10_000n; // cents
  return sessions.map((d, i) => {
    const close = (base * (100n + BigInt(i))) / 100n; // cents
    const closeMicro = close * 10_000n; // cents -> micro
    return {
      d,
      open: closeMicro - 5_000n,
      high: closeMicro + 20_000n,
      low: closeMicro - 20_000n,
      close: closeMicro,
      volume: 100_000n + BigInt(i) * 1_000n,
    };
  });
}

export function indexFor(start: bigint, sessions: readonly string[] = SESSIONS): IndexViewBar[] {
  return sessions.map((d, i) => ({ d, close: (start + BigInt(i) * 7n) * M }));
}

export function calendarFor(
  sessions: readonly string[],
  holidays: readonly string[],
): CalendarRow[] {
  return [
    ...sessions.map((d): CalendarRow => ({ d, kind: "session", close_time: null, confirmed: 1 })),
    ...holidays.map((d): CalendarRow => ({ d, kind: "holiday", close_time: null, confirmed: 1 })),
  ].sort((a, b) => (a.d < b.d ? -1 : 1));
}

/** ZZC: 2-for-1 split, ex 2026-03-11, confirmed on the 10th at 16:00 Melbourne (05:00Z). */
export const ZZC_SPLIT: CorpActionRecord = {
  id: "ca-zzc-split",
  code: "ZZC",
  type: "split",
  exDate: "2026-03-11",
  payload: { new: 2, old: 1 },
  knownAt: "2026-03-10T05:00:00.000Z",
};

/** ZZA: cash dividend A$0.10, ex 2026-03-05, vendor row without known_at (known the session before). */
export const ZZA_DIVIDEND: CorpActionRecord = {
  id: "ca-zza-div",
  code: "ZZA",
  type: "cash_dividend",
  exDate: "2026-03-05",
  payload: { dps: "0.10", pay_date: "2026-03-20" },
  knownAt: null,
};

export function eventRow(
  code: string,
  day0: string,
  publishedAt: string,
  timed: boolean,
): EventRow {
  return {
    id: `asx|${code}-${day0}`,
    code,
    day0,
    groupKey: `${code}|${day0}`,
    category: "results",
    priceSensitive: true,
    polarity: 1,
    ar: null,
    volRatio: null,
    timed,
    day0LowMicro: null,
    publishedAt,
  };
}

export function zzWorld(overrides: Partial<AsOfWorld> = {}): AsOfWorld {
  const params: AgentParams = defaultAgentParams();
  return {
    market: "AU",
    sessions: SESSIONS,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(SESSIONS, [HOLIDAY]),
    schemaSha: "schema-zz-1",
    bars: new Map(CODES.map((c) => [c, barsFor(c)])),
    tiers: new Map([
      ["ZZA", [{ d: "2026-03-02", tier: "U1" as const }]],
      ["ZZB", [{ d: "2026-03-02", tier: "U2" as const }]],
      // ZZC joins the universe from the 10th: before that it has bars but no tier.
      ["ZZC", [{ d: "2026-03-10", tier: "U3" as const }]],
    ]),
    index: {
      AXJO: indexFor(7_000n),
      GSPC: indexFor(5_000n),
      VIX: indexFor(15n),
    },
    shorts: new Map([
      [
        "ZZA",
        [
          { asOf: "2026-03-02", ppm: 12_000 },
          { asOf: "2026-03-03", ppm: 13_000 },
        ],
      ],
    ]),
    macro: new Map([
      ["RBA_CASH_RATE", [{ obsD: "2026-03-03", value: 3.6 }]],
      ["DGS10", [{ obsD: "2026-03-02", value: 4.2 }]],
      ["CPIAUCSL", [{ obsD: "2026-03-01", value: 320.1 }]],
    ]),
    events: new Map([
      // Timed: published 10:30 Melbourne on the 5th (23:30Z on the 4th) -> usable at the 5th's cut-off.
      ["ZZA", [eventRow("ZZA", "2026-03-05", "2026-03-04T23:30:00.000Z", true)]],
      // Untimed backfill dated the 6th -> +1 session -> usable from the 10th.
      ["ZZB", [eventRow("ZZB", "2026-03-06", "2026-03-06", false)]],
    ]),
    corpActions: new Map([
      ["ZZC", [ZZC_SPLIT]],
      ["ZZA", [ZZA_DIVIDEND]],
    ]),
    indexChanges: new Map([
      [
        "ZZB",
        [
          {
            indexName: "ZZ200",
            kind: "add" as const,
            announced: "2026-03-04",
            effective: "2026-03-12",
          },
        ],
      ],
    ]),
    industry: new Map([["ZZA", [{ asOf: "2026-03-03", industry: "Materials" }]]]),
    halts: new Map([
      [
        "ZZB",
        [
          { d: "2026-03-11", halted: true },
          { d: "2026-03-13", halted: false },
        ],
      ],
    ]),
    regimeParams: params,
    ...overrides,
  };
}

/**
 * 300 weekday sessions from 2025-01-06 with a benchmark that moves between regimes: a calming
 * rise (RISK-ON once the SMA is warm), a ten-session crash (SHOCK: the 5-session fall is above
 * 7 %), then a choppy recovery. The regime params shorten the SMA and the volatility lookback
 * (defaults 200 and 1,260 sessions) so the classifier is warm inside the fixture.
 */
export function regimeWorld(): AsOfWorld {
  const sessions: string[] = [];
  const start = Date.UTC(2025, 0, 6);
  for (let i = 0; sessions.length < 300; i += 1) {
    const t = new Date(start + i * 86_400_000);
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    sessions.push(t.toISOString().slice(0, 10));
  }
  const axjo: IndexViewBar[] = sessions.map((d, i) => {
    let level: number;
    if (i < 150) {
      // rise 8 points a session; the wobble amplitude shrinks so realised volatility falls
      level = 7_000 + 8 * i + ((i * 37) % 7) * Math.max(1, 10 - Math.floor(i / 15));
    } else if (i < 160) {
      level = 8_200 - 120 * (i - 149); // crash: about 1.5 % a session
    } else {
      level = 7_000 + 4 * (i - 160) + ((i * 53) % 9) * 6; // choppy recovery
    }
    return { d, close: BigInt(level) * M };
  });
  const base = defaultAgentParams();
  const regimeParams: AgentParams = {
    ...base,
    windows: { ...base.windows, regimeVolLookback: 60 },
    regime: { ...base.regime, smaSessions: 50 },
  };
  return {
    market: "AU",
    sessions,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(sessions, []),
    schemaSha: "schema-zz-regime",
    bars: new Map([["ZZA", barsFor("ZZA", sessions)]]),
    index: { AXJO: axjo },
    regimeParams,
  };
}
