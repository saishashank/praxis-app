// Synthetic worlds for the T11 signal-ledger tests (design decision 35: public ZZ codes, invented
// numbers, no market data). Two builders:
//   handSource  - explicit bars per code for hand-computed walks (no indicators);
//   buildWorld  - a LedgerSource over bar series: family inputs, position facts and the control
//                 universe are built from the SAME bars by the production fact builders, using only
//                 data up to the requested session (so a look-ahead bug shows when the future is
//                 poisoned).
import type { ViewBar } from "@/lib/agents/decisionView";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { logReturns, microToFloat, stdevFloat } from "@/lib/agents/indicators";
import { buildCodeFacts } from "@/lib/agents/families/facts";
import type {
  CodeFacts,
  EventFact,
  FamilyInputs,
  Tier,
} from "@/lib/agents/families/types";
import type { AgentParams } from "@/lib/agents/params";
import type { LedgerSource } from "@/lib/replay/ledger";
import type { PoolCode } from "@/lib/replay/controlLibrary";
import type { PathSource, PositionFacts } from "@/lib/replay/returns";
import { floorRat } from "@/lib/money/round";
import { SESSIONS, sessionList } from "../agents/families/builders";

export { SESSIONS, sessionList };

export function viewBar(d: string, o: bigint, h: bigint, l: bigint, c: bigint, v = 1_000_000n): ViewBar {
  return { d, open: o, high: h, low: l, close: c, volume: v };
}

const NO_FACTS: PositionFacts = {
  atrMicro: null,
  closeAboveExitSma: null,
  volumeRatios: [],
  events: [],
};

/** Explicit bars per code (null = no trading that session); positionFacts as given. */
export function handSource(
  sessions: readonly string[],
  bars: Readonly<Record<string, readonly (ViewBar | null)[]>>,
  facts: PositionFacts | null = NO_FACTS,
  spy?: { bar: string[]; facts: string[] },
  actions: readonly CorpActionRecord[] = [],
): PathSource {
  return {
    sessions,
    corpActions: (code) => actions.filter((a) => a.code === code),
    bar(code, d) {
      spy?.bar.push(d);
      const i = sessions.indexOf(d);
      return bars[code]?.[i] ?? null;
    },
    positionFacts(_code, d) {
      spy?.facts.push(d);
      return facts;
    },
  };
}

export type WorldCode = { code: string; tier: Tier; bars: readonly ViewBar[] };

export type WorldOptions = {
  readonly events?: readonly EventFact[];
  /** Bars with index > this are replaced by a poison bar in every lookup. */
  readonly poisonAfter?: number;
  /** familyInputs for an index > this throws (look-ahead tripwire). */
  readonly failInputsAfter?: number;
};

const POISON = 777_000_000n;

export function buildWorld(codes: readonly WorldCode[], p: AgentParams, o: WorldOptions = {}) {
  const sessions = SESSIONS;
  const byCode = new Map(codes.map((c) => [c.code, c]));
  const poisoned = (b: ViewBar, i: number): ViewBar =>
    o.poisonAfter !== undefined && i > o.poisonAfter
      ? { d: b.d, open: POISON, high: POISON, low: POISON, close: POISON, volume: 1n }
      : b;
  const barAt = (code: string, i: number): ViewBar | null => {
    const b = byCode.get(code)?.bars[i];
    return b === undefined ? null : poisoned(b, i);
  };
  const factsMemo = new Map<string, CodeFacts>();
  const factsAt = (code: string, i: number): CodeFacts => {
    const key = `${code}|${i}`;
    let f = factsMemo.get(key);
    if (f === undefined) {
      const c = byCode.get(code)!;
      const slice = c.bars.slice(0, i + 1);
      f = buildCodeFacts({ code, tier: c.tier, adjusted: slice, raw: slice }, p);
      factsMemo.set(key, f);
    }
    return f;
  };
  const idxOf = (d: string): number => {
    const i = sessions.indexOf(d);
    if (i < 0) throw new RangeError(`unknown session ${d}`);
    return i;
  };
  const events = o.events ?? [];

  const source: LedgerSource & { inputsCalls: string[] } = {
    sessions,
    inputsCalls: [],
    bar: (code, d) => barAt(code, idxOf(d)),
    positionFacts(code, d) {
      const i = idxOf(d);
      const f = factsAt(code, i);
      return {
        atrMicro: f.ind.atrMicro,
        closeAboveExitSma: f.ind.closeAboveSmaShort,
        volumeRatios: [f.ind.volumeRatio],
        events: events.filter((e) => e.code === code && e.day0 <= d),
      };
    },
    familyInputs(d): FamilyInputs {
      const i = idxOf(d);
      if (o.failInputsAfter !== undefined && i > o.failInputsAfter) {
        throw new Error(`look-ahead: familyInputs(${d}) is after the cut`);
      }
      source.inputsCalls.push(d);
      return {
        market: "AU",
        d,
        regime: "RISK-ON",
        sessions: sessions.slice(0, i + 1),
        sources: { asx: "on", asic: "on" },
        eventCoverage: true,
        codes: codes.map((c) => factsAt(c.code, i)),
        events: events.filter((e) => e.day0 <= d),
      };
    },
    controlUniverse(d): readonly PoolCode[] {
      const i = idxOf(d);
      return codes.map((c): PoolCode => {
        const f = factsAt(c.code, i);
        const closes = c.bars.slice(0, i + 1).map((b) => microToFloat(b.close));
        return {
          code: c.code,
          tier: c.tier,
          vol20: stdevFloat(logReturns(closes), 20, 1),
          atrMicro: f.ind.atrMicro,
          advMicro: f.ind.adv === null ? 0n : floorRat(f.ind.adv),
          eligible: c.tier === "U1" && f.ind.atrWarm,
        };
      });
    },
  };
  return source;
}
