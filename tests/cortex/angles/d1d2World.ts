// Synthetic ZZ worlds for the D1 / D2 angle tests (M15 C1b; AT-50 pattern: ZZ codes only). A
// world of N weekday sessions whose bars come from a caller-supplied close path (cents) with a
// fixed high / low bracket and a volume path, so hand computation is one line per angle. Tiers,
// an industry map and ^AXJO are present so `codes(t)`, `industry` and `index` answer.
import { defaultAgentParams } from "@/lib/agents/params";
import type { IndexViewBar, ViewBar } from "@/lib/agents/decisionView";
import type { AsOfWorld } from "@/lib/cortex/pit/types";
import { calendarFor } from "../pit/zzWorld";

export const CUTOFF_HHMM = "18:10";
const MICRO_PER_CENT = 10_000n;

/** `n` weekday session dates from 2024-01-01 (a Monday). */
export function weekdaySessions(n: number, start = Date.UTC(2024, 0, 1)): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n; i += 1) {
    const d = new Date(start + i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export type PathSpec = {
  /** Close in cents per session. */
  readonly close: (i: number) => number;
  /** Volume in shares per session (default 100,000). */
  readonly volume?: (i: number) => number;
  /** High = close + hi cents, low = close - lo cents (defaults 2 / 2); open = prior close. */
  readonly hi?: (i: number) => number;
  readonly lo?: (i: number) => number;
  readonly open?: (i: number, prevClose: number) => number;
};

export function barsFromPath(sessions: readonly string[], spec: PathSpec): ViewBar[] {
  const out: ViewBar[] = [];
  let prev = spec.close(0);
  for (let i = 0; i < sessions.length; i += 1) {
    const close = spec.close(i);
    const hi = spec.hi ? spec.hi(i) : 2;
    const lo = spec.lo ? spec.lo(i) : 2;
    const open = spec.open ? spec.open(i, prev) : prev;
    const high = Math.max(close, open) + hi;
    const low = Math.min(close, open) - lo;
    out.push({
      d: sessions[i]!,
      open: BigInt(open) * MICRO_PER_CENT,
      high: BigInt(high) * MICRO_PER_CENT,
      low: BigInt(low) * MICRO_PER_CENT,
      close: BigInt(close) * MICRO_PER_CENT,
      volume: BigInt(spec.volume ? spec.volume(i) : 100_000),
    });
    prev = close;
  }
  return out;
}

/** A deterministic LCG in [0, 1): no Math.random anywhere in the tests. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

/** A wobbly but bounded close path (cents) from a seed: base x (1 + 0.3 sin) + noise. */
export function wobble(seed: number, base = 1_000): (i: number) => number {
  const r = lcg(seed);
  const noise: number[] = [];
  return (i) => {
    while (noise.length <= i) noise.push(Math.floor(r() * 40) - 20);
    return Math.max(50, Math.round(base * (1 + 0.3 * Math.sin(i / 23)) + noise[i]!));
  };
}

export type ZzWorldSpec = {
  readonly sessions: readonly string[];
  readonly codes: Readonly<Record<string, PathSpec>>;
  /** Industry per code; absent = no industry row. */
  readonly industry?: Readonly<Record<string, string>>;
  readonly overrides?: Partial<AsOfWorld>;
};

export function synthWorld(spec: ZzWorldSpec): AsOfWorld {
  const { sessions } = spec;
  const first = sessions[0]!;
  const codes = Object.keys(spec.codes).sort();
  const axjo: IndexViewBar[] = sessions.map((d, i) => ({
    d,
    close: BigInt(7_000 + (i % 50)) * 1_000_000n,
  }));
  return {
    market: "AU",
    sessions,
    cutoffHhmm: CUTOFF_HHMM,
    calendar: calendarFor(sessions, []),
    schemaSha: "schema-zz-d12",
    bars: new Map(codes.map((c) => [c, barsFromPath(sessions, spec.codes[c]!)])),
    tiers: new Map(codes.map((c) => [c, [{ d: first, tier: "U1" as const }]])),
    index: { AXJO: axjo },
    industry: spec.industry
      ? new Map(Object.entries(spec.industry).map(([c, g]) => [c, [{ asOf: first, industry: g }]]))
      : undefined,
    regimeParams: defaultAgentParams(),
    ...spec.overrides,
  };
}
