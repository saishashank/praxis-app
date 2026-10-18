// A LedgerSource / CohortReplaySource over arbitrary bar series (M4 T14 tests; design decision 35:
// public ZZ codes, invented numbers). Family inputs, position facts and the control universe come
// from the SAME bars through the production fact builders, using only data up to the requested
// session (a look-ahead bug shows when the future is poisoned). Differences from ledgerWorld's
// buildWorld: the session list is a parameter, and confirmed corporate actions can be supplied.
import type { Client } from "@libsql/client";
import type { ViewBar } from "@/lib/agents/decisionView";
import { adjustBars, splitActionsByCode } from "@/lib/agents/candidates";
import { buildCodeFacts } from "@/lib/agents/families/facts";
import type { CodeFacts, EventFact, FamilyInputs, Tier } from "@/lib/agents/families/types";
import { logReturns, microToFloat, stdevFloat } from "@/lib/agents/indicators";
import type { AgentParams } from "@/lib/agents/params";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { toMicroFromVendor } from "@/lib/money/micro";
import { floorRat } from "@/lib/money/round";
import type { PoolCode } from "@/lib/replay/controlLibrary";
import type { LedgerSource } from "@/lib/replay/ledger";

export type WorldSeries = { code: string; tier: Tier; bars: readonly (ViewBar | null)[] };

export type CohortWorldOptions = {
  readonly events?: readonly EventFact[];
  readonly actions?: readonly CorpActionRecord[];
  /** Bars with session index > this are replaced by a poison bar in every lookup. */
  readonly poisonAfter?: number;
  /** familyInputs for a session index above this throws (look-ahead tripwire). */
  readonly failInputsAfter?: number;
};

const POISON = 777_000_000n;

export function buildCohortWorld(
  sessions: readonly string[],
  series: readonly WorldSeries[],
  p: AgentParams,
  o: CohortWorldOptions = {},
): LedgerSource & { inputsCalls: string[] } {
  const byCode = new Map(series.map((s) => [s.code, s]));
  const idx = new Map<string, number>();
  sessions.forEach((d, i) => idx.set(d, i));
  const idxOf = (d: string): number => {
    const i = idx.get(d);
    if (i === undefined) throw new RangeError(`unknown session ${d}`);
    return i;
  };
  const poisoned = (b: ViewBar, i: number): ViewBar =>
    o.poisonAfter !== undefined && i > o.poisonAfter
      ? { d: b.d, open: POISON, high: POISON, low: POISON, close: POISON, volume: 1n }
      : b;
  const barAt = (code: string, i: number): ViewBar | null => {
    const b = byCode.get(code)?.bars[i];
    return b === undefined || b === null ? null : poisoned(b, i);
  };
  const history = (code: string, i: number): ViewBar[] =>
    (byCode.get(code)?.bars.slice(0, i + 1) ?? []).filter((b): b is ViewBar => b !== null);
  const adjustedHistory = (code: string, i: number): ViewBar[] => {
    const known = (o.actions ?? []).filter((a) => a.exDate <= sessions[i]!);
    const splits = splitActionsByCode(known).byCode.get(code) ?? [];
    return adjustBars(history(code, i), splits).map((b) => ({ ...b }));
  };
  const factsMemo = new Map<string, CodeFacts | null>();
  const factsAt = (code: string, i: number): CodeFacts | null => {
    const key = `${code}|${i}`;
    if (factsMemo.has(key)) return factsMemo.get(key)!;
    let f: CodeFacts | null = null;
    if (barAt(code, i) !== null) {
      const slice = history(code, i);
      f = buildCodeFacts(
        { code, tier: byCode.get(code)!.tier, adjusted: adjustedHistory(code, i), raw: slice },
        p,
      );
    }
    factsMemo.set(key, f);
    return f;
  };
  const events = o.events ?? [];
  const actions = o.actions ?? [];
  const source: LedgerSource & { inputsCalls: string[] } = {
    sessions,
    inputsCalls: [],
    corpActions: (code) => actions.filter((a) => a.code === code),
    bar: (code, d) => barAt(code, idxOf(d)),
    positionFacts(code, d) {
      const i = idxOf(d);
      const f = factsAt(code, i);
      if (f === null) return null;
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
      const codes: CodeFacts[] = [];
      for (const s of series) {
        const f = factsAt(s.code, i);
        if (f !== null) codes.push(f);
      }
      return {
        market: "AU",
        d,
        regime: "RISK-ON",
        sessions: sessions.slice(0, i + 1),
        sources: { asx: "on", asic: "on" },
        eventCoverage: true,
        codes,
        events: events.filter((e) => e.day0 <= d),
      };
    },
    controlUniverse(d): readonly PoolCode[] {
      const i = idxOf(d);
      const out: PoolCode[] = [];
      for (const s of series) {
        const f = factsAt(s.code, i);
        if (f === null) continue;
        const closes = adjustedHistory(s.code, i).map((b) => microToFloat(b.close));
        out.push({
          code: s.code,
          tier: s.tier,
          vol20:
            closes.length < p.windows.vol + 1
              ? null
              : stdevFloat(logReturns(closes).slice(-p.windows.vol), p.windows.vol, 1),
          atrMicro: f.ind.atrMicro,
          advMicro: f.ind.adv === null ? 0n : floorRat(f.ind.adv),
          eligible: s.tier === "U1" && f.ind.atrWarm,
        });
      }
      return out;
    },
  };
  return source;
}

/** Bars of the replay harness database (`price_bar`, vendor decimals) as world series. */
export async function seriesFromHarness(
  db: Client,
  dates: readonly string[],
  tiers: Readonly<Record<string, { readonly tier: Tier }>>,
): Promise<WorldSeries[]> {
  const rs = await db.execute(
    "SELECT code, d, o, h, l, c, volume FROM price_bar ORDER BY code, d",
  );
  const byCode = new Map<string, Map<string, ViewBar>>();
  for (const r of rs.rows) {
    const code = String(r.code);
    const d = String(r.d);
    let m = byCode.get(code);
    if (m === undefined) byCode.set(code, (m = new Map()));
    m.set(d, {
      d,
      open: toMicroFromVendor(Number(r.o)),
      high: toMicroFromVendor(Number(r.h)),
      low: toMicroFromVendor(Number(r.l)),
      close: toMicroFromVendor(Number(r.c)),
      volume: BigInt(Number(r.volume)),
    });
  }
  return [...byCode.keys()].sort().map((code) => ({
    code,
    tier: tiers[code]!.tier,
    bars: dates.map((d) => byCode.get(code)!.get(d) ?? null),
  }));
}
