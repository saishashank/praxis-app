// Synthetic ZZ world for the C3c night tests (AT-50 pattern: ZZ codes, no real data). Forty weekday
// sessions from 2026-02-02, four U1 codes with distinct drifts, two industries, a flat ^AXJO (the
// regime is overridden on the view: the real classifier needs 1,280 sessions of history), two
// synthetic score angles with a compute, one map per family fitted on that scored set, generous
// cells for every volatility bucket, and three books.
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { Family, RegimeLabel } from "@/lib/agents/families/types";
import { defaultAgentParams } from "@/lib/agents/params";
import { COST_PROFILES } from "@/lib/arena/costs";
import type { CalendarRow } from "@/lib/data/calendar";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import type { AsOfView, AsOfWorld } from "@/lib/cortex/pit/types";
import type { AngleDef, AngleStatus } from "@/lib/cortex/angles/types";
import { activeSetHash } from "@/lib/cortex/score/map";
import type { CortexMap, ScoredAngle } from "@/lib/cortex/score/types";
import type { BookState, FamilyNightRule, NightInputs } from "@/lib/cortex/night";
import { VOL_BUCKETS } from "@/lib/cortex/night";
import { cellKey, TOP3_BAND_KEY, type CellStatistic } from "@/lib/stats/cells";
import { scopedPrng } from "@/lib/stats/rng";
import { makeRational } from "@/lib/money/rational";

export const CUTOFF_HHMM = "18:10";
export const CENT = 10_000n;

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
export const CODES = ["ZZA", "ZZB", "ZZC", "ZZD"] as const;

/** Per-code base price (cents) and drift per session (bps); the wobble gives a non-trivial ATR. */
const SPEC: Readonly<Record<string, { base: number; driftBps: number; wobble: number }>> = {
  ZZA: { base: 2_000, driftBps: 40, wobble: 3 },
  ZZB: { base: 500, driftBps: 10, wobble: 2 },
  ZZC: { base: 10_000, driftBps: -20, wobble: 5 },
  ZZD: { base: 50, driftBps: 0, wobble: 1 },
};

export function barsFor(code: string, sessions: readonly string[] = SESSIONS): ViewBar[] {
  const s = SPEC[code]!;
  let level = s.base;
  return sessions.map((d, i) => {
    level = level * (1 + s.driftBps / 10_000);
    const closeC = Math.round(level * 100) / 100 + ((i * 7) % 3) * s.wobble;
    const close = BigInt(Math.round(closeC * 100)) * 100n; // 2 dp cents -> micro
    const range = BigInt(s.wobble) * CENT;
    return {
      d,
      open: close - range / 2n,
      high: close + range,
      low: close - range,
      close,
      volume: (code === "ZZD" ? 2_000_000n : 100_000n) + BigInt(i) * 500n,
    };
  });
}

export function flatIndex(sessions: readonly string[] = SESSIONS): IndexViewBar[] {
  return sessions.map((d) => ({ d, close: 7_000n * 1_000_000n }));
}

export function calendarFor(sessions: readonly string[]): CalendarRow[] {
  return sessions.map((d): CalendarRow => ({ d, kind: "session", close_time: null, confirmed: 1 }));
}

export function nightWorld(overrides: Partial<AsOfWorld> = {}): AsOfWorld {
  return {
    market: "AU",
    sessions: SESSIONS,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(SESSIONS),
    schemaSha: "schema-zz-night",
    bars: new Map(CODES.map((c) => [c, barsFor(c)])),
    tiers: new Map(CODES.map((c) => [c, [{ d: SESSIONS[0]!, tier: "U1" as const }]])),
    index: { AXJO: flatIndex() },
    industry: new Map([
      ["ZZA", [{ asOf: SESSIONS[0]!, industry: "Materials" }]],
      ["ZZB", [{ asOf: SESSIONS[0]!, industry: "Materials" }]],
      ["ZZC", [{ asOf: SESSIONS[0]!, industry: "Energy" }]],
      ["ZZD", [{ asOf: SESSIONS[0]!, industry: "Financials" }]],
    ]),
    indexChanges: new Map(),
    regimeParams: defaultAgentParams(),
    ...overrides,
  };
}

/** The view with the regime pinned (the classifier needs years of history the fixture has not). */
export function nightView(world: AsOfWorld, regime: RegimeLabel = "NEUTRAL"): AsOfView {
  const v = buildAsOfView(world);
  return { ...v, regime: () => regime };
}

// ---- synthetic angles ------------------------------------------------------------------------------------

const MOM_WINDOW = 6;
const VOL_WINDOW = 11;

/** Two score angles with a compute: 5-session momentum and 10-session range (low volatility, oriented −1). */
export const NIGHT_ANGLES: readonly AngleDef[] = [
  {
    id: "A-D1-01",
    version: 1,
    domain: 1,
    title: "ZZ momentum",
    definition: "close over the close five sessions back, minus one",
    kind: "score",
    cluster: "momentum",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: MOM_WINDOW,
    inputs: ["bar_au"],
    grid: {},
    compute: (view, code, t) => {
      const s = view.adj(code, t, MOM_WINDOW);
      if (s.adjClose.length < MOM_WINDOW) return undefined;
      const a = s.adjClose[0]!;
      const b = s.adjClose[s.adjClose.length - 1]!;
      return Number(b - a) / Number(a);
    },
  },
  {
    id: "A-D1-02",
    version: 1,
    domain: 1,
    title: "ZZ range",
    definition: "ten-session high-low range over the close",
    kind: "score",
    cluster: "low_volatility",
    orientation: -1,
    horizonSessions: 20,
    warmupSessions: VOL_WINDOW,
    inputs: ["bar_au"],
    grid: {},
    compute: (view, code, t) => {
      const bars = view.bars(code, t, VOL_WINDOW);
      if (bars.length < VOL_WINDOW) return undefined;
      let hi = 0n;
      let lo = -1n;
      for (const b of bars) {
        if (b.high > hi) hi = b.high;
        if (lo < 0n || b.low < lo) lo = b.low;
      }
      return Number(hi - lo) / Number(bars[bars.length - 1]!.close);
    },
  },
  {
    id: "A-D2-01",
    version: 1,
    domain: 2,
    title: "ZZ volume trend",
    definition: "last volume over the mean of the ten before it, minus one",
    kind: "score",
    cluster: "liquidity",
    orientation: 1,
    horizonSessions: 20,
    warmupSessions: VOL_WINDOW,
    inputs: ["bar_au"],
    grid: {},
    compute: (view, code, t) => {
      const bars = view.bars(code, t, VOL_WINDOW);
      if (bars.length < VOL_WINDOW) return undefined;
      let sum = 0n;
      for (let i = 0; i < bars.length - 1; i += 1) sum += bars[i]!.volume;
      const mean = Number(sum) / (bars.length - 1);
      return Number(bars[bars.length - 1]!.volume) / mean - 1;
    },
  },
];

export const PASSPORTS: ReadonlyMap<string, AngleStatus> = new Map([
  ["A-D1-01", "active"],
  ["A-D1-02", "active"],
  ["A-D2-01", "active"],
]);

export const SCORED: readonly ScoredAngle[] = NIGHT_ANGLES.map((a) => ({
  id: a.id,
  version: a.version,
  cluster: a.cluster as ScoredAngle["cluster"],
}));
export const HASH = activeSetHash(SCORED);

export const CLUSTERS = ["momentum", "low_volatility", "liquidity"] as const;

export function mapFor(family: Family): CortexMap {
  return {
    family,
    ruleVersion: `${family}.zz.1`,
    fittedAt: "2026-01-31T00:00:00.000Z",
    a: 1.2,
    b: 0.1,
    sMean: 0,
    sSd: 0.5,
    K: 3,
    clusters: [...CLUSTERS],
    activeSetHash: HASH,
    nEff: 250,
  };
}

export function ruleFor(family: Family, extra: Partial<FamilyNightRule> = {}): FamilyNightRule {
  return {
    ruleVersion: `${family}.zz.1`,
    clusters: [...CLUSTERS],
    familyMeanNet: 0.01,
    stopK: makeRational(2n),
    gainLoss: { gain: 0.1, loss: 0.06 },
    ...extra,
  };
}

/** A healthy cell: 100 filled setups, 25 blocks, bound 1 %, gap95 3 %, every regime fine. */
export function cellStat(key: string, overrides: Partial<CellStatistic> = {}): CellStatistic {
  const regimes = ["NEUTRAL", "RISK-ON", "RISK-OFF", "SHOCK"];
  const byRegime: Record<string, { n: number; meanNet: number }> = {};
  for (const r of regimes) byRegime[r] = { n: 40, meanNet: 0.02 };
  const bound = {
    point: 0.03,
    lo: 0.005,
    hi: 0.055,
    level: 0.9 as const,
    nEff: 80,
    oneSidedLo: 0.01,
    oneSidedHi: 0.05,
    rows: 100,
    uniqueShare: 0.9,
    designEffect: 1.1,
    blocks: 25,
  } as unknown as CellStatistic["bound"];
  return {
    cellKey: key,
    n: 100,
    blocks: 25,
    nEff: 80,
    meanNet: 0.03,
    lower90: 0.01,
    bound,
    lReal: 0.05,
    gap95: 0.03,
    byRegime,
    excludedUnfilledShare: 0.1,
    ...overrides,
  };
}

export function cellsFor(families: readonly Family[]): Map<string, CellStatistic> {
  const out = new Map<string, CellStatistic>();
  for (const f of families) {
    for (const v of VOL_BUCKETS) {
      const k = cellKey(f, TOP3_BAND_KEY, v, "U1");
      out.set(k, cellStat(k));
    }
  }
  return out;
}

export function book(bookId: string, family: Family, extra: Partial<BookState> = {}): BookState {
  return {
    bookId,
    family,
    executionId: `E-${bookId}`,
    // one legacy line outside the universe (valued at cost) so the book is not all cash
    positions: [
      {
        code: "ZZX",
        qty: 1_000n,
        costMicro: 10_000_000_000n,
        stopMicro: 8_000_000n,
        entryD: SESSIONS[0]!,
      },
    ],
    settledCashMicro: 2_500_000_000n,
    navMicro: 12_500_000_000n,
    costProfile: COST_PROFILES.P1,
    sessionsSinceGoLive: 10,
    ...extra,
  };
}

export const BOOKS: readonly BookState[] = [
  book("E01", "F1"),
  book("E04", "F4"),
  book("E05", "F5"),
];

/** Night inputs at session index `t` (default: the last session); F1 allowed, F4 and F5 shadow. */
export function nightInputs(
  t: number = SESSIONS.length - 1,
  overrides: Partial<NightInputs> = {},
  view: AsOfView = nightView(nightWorld()),
): NightInputs {
  return {
    market: "AU",
    d: view.sessions[t]!,
    t,
    view,
    params: defaultAgentParams(),
    status: { F1: "allowed", F4: "shadow", F5: "shadow" },
    maps: new Map<Family, CortexMap>([
      ["F1", mapFor("F1")],
      ["F4", mapFor("F4")],
      ["F5", mapFor("F5")],
    ]),
    cells: cellsFor(["F1", "F4", "F5"]),
    books: BOOKS,
    rules: new Map<Family, FamilyNightRule>([
      ["F1", ruleFor("F1")],
      ["F4", ruleFor("F4")],
      ["F5", ruleFor("F5")],
    ]),
    states: [],
    passports: PASSPORTS,
    angles: NIGHT_ANGLES,
    kills: { arena: false, families: new Set(), sourcesOff: new Set() },
    prng: (scope) => scopedPrng(scope),
    ...overrides,
  };
}
