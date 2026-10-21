// Control path library (M4 T11; design 4.7 and decisions 25 and 33; ARN-004, ARN-080/081).
// For a signal-ledger row the library draws `c2_controls_per_row` matched random-entry controls:
// same family, same entry session, same tier and same 20-session volatility decile (deciles over
// that tier's eligible codes on the decision session), excluding the signal's code and any code
// with a qualifying signal of the family that day. A control enters at the same next open and exits
// by the family's exit plan mapped onto it (M3 `mapControlExits`: event-anchored levels re-expressed
// in the control's own ATR units, event-dependent exits replaced by the family time stop). Control
// outcomes are computed lazily and memoised per (family, code, entry session, mapped plan), so rows
// of different variants share them. Draws are seeded with `lib:<lineage>:<row>` (design 2.8); a pool
// with fewer than 20 usable codes is drawn with replacement and the pool size is recorded.
// Pure: no clock, no Math.random; every iteration is sorted.
import {
  familyOutputJson,
  type CsRule,
  type ExitPlan,
  type Family,
  type InitialStopRule,
  type StopSpec,
  type Tier,
} from "@/lib/agents/families";
import { divFloor } from "@/lib/money/rational";
import {
  createPrng,
  deriveRngSeed,
  mapControlExits,
  type FamilyId,
  type MappedExit,
} from "@/lib/arena/cohort";
import {
  economicsOf,
  walkPosition,
  type CostSetup,
  type PathSource,
  type WalkFilled,
} from "./returns";

/** One code of the control universe on a decision session. */
export type PoolCode = {
  readonly code: string;
  readonly tier: Tier;
  /** 20-session volatility; null = not computable (never a pool member). */
  readonly vol20: number | null;
  /** ATR(20) in micro on the decision session; null = not warm (not a pool member). */
  readonly atrMicro: bigint | null;
  /** 20-session ADV (traded value, micro). */
  readonly advMicro: bigint;
  /** Passes the family's entry filters (tier ADV, halts, ARN-011 for U2/U3, quality gate). */
  readonly eligible: boolean;
};

export interface ControlSource extends PathSource {
  /** The universe on decision session `d` for a family (all tracked codes, with eligibility). */
  controlUniverse(d: string, family: Family): readonly PoolCode[];
}

export type EventAnchor = {
  /** Rule id in the M3 table (`F3.is_event_low`, `F2.cs_event_low`). */
  readonly ruleId: string;
  /** Signal-side distance from the entry-day open to the event level, never negative. */
  readonly distanceMicro: bigint;
  /** ATR(20) at the signal's decision session. */
  readonly atrMicro: bigint;
};

export type ControlRequest = {
  /** Row id (`lr:...`), the seed scope's last part. */
  readonly rowId: string;
  /** `<market>:<family>`. */
  readonly lineage: string;
  readonly family: Family;
  readonly signalCode: string;
  readonly tier: Tier;
  readonly decisionIdx: number;
  /** Same entry session as the row (decisionIdx + 1). */
  readonly entryIdx: number;
  readonly endIdx: number;
  readonly plan: ExitPlan;
  readonly anchors: readonly EventAnchor[];
  /** Codes never drawn: the signal's code and every code with a same-day qualifying signal. */
  readonly excludeCodes: ReadonlySet<string>;
  readonly count: number;
};

/** `ledger_control` row (migration 0008): amounts as exact fractions of micro amounts. */
export type LedgerControlRecord = {
  readonly row_id: string;
  readonly idx: number;
  readonly code: string;
  readonly entry_d: string;
  readonly exit_d: string;
  readonly net_num: bigint;
  readonly net_den: bigint;
  readonly stress_num: bigint;
  readonly stress_den: bigint;
};

export type ControlDraw = {
  readonly controls: readonly LedgerControlRecord[];
  /** 1-based indexes of controls whose exit was forced at the end of the data (censored). */
  readonly forcedIdx: readonly number[];
  /** Codes in the matched pool (same tier and decile, excluding the signal and same-day signals). */
  readonly poolSize: number;
  /** Pool codes that could be entered (a bar, affordable, mapped exit valid). */
  readonly usableSize: number;
  /** Fewer usable codes than controls: drawn with replacement. */
  readonly withReplacement: boolean;
  /** The signal code's volatility decile (0..9), null when it cannot be placed. */
  readonly decile: number | null;
  readonly note: string | null;
};

const DECILES = 10n; // threshold-ok: deciles of 20-session volatility (decision 33, ARN-004)

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Decile 0..9 of a (vol20, code) among a sorted eligible list: floor(10 x rank / n). */
function decileOf(rank: number, n: number): number {
  return Number(divFloor(BigInt(rank) * DECILES, BigInt(n)));
}

/** Volatility deciles of one tier's eligible codes (vol20 ascending, ties by code ascending). */
export function tierDeciles(universe: readonly PoolCode[], tier: Tier): Map<string, number> {
  const members = universe
    .filter((c) => c.tier === tier && c.eligible && c.vol20 !== null && c.atrMicro !== null)
    .sort((a, b) => (a.vol20! < b.vol20! ? -1 : a.vol20! > b.vol20! ? 1 : cmp(a.code, b.code)));
  const out = new Map<string, number>();
  members.forEach((c, i) => out.set(c.code, decileOf(i, members.length)));
  return out;
}

/** Decile of a code that may itself be outside the eligible set: its rank among the eligible. */
function signalDecile(universe: readonly PoolCode[], tier: Tier, code: string): number | null {
  const own = universe.find((c) => c.code === code);
  if (own === undefined || own.vol20 === null) return null;
  const members = universe.filter(
    (c) =>
      c.tier === tier && c.eligible && c.vol20 !== null && c.atrMicro !== null && c.code !== code,
  );
  const n = members.length + 1;
  const rank = members.filter(
    (c) => c.vol20! < own.vol20! || (c.vol20! === own.vol20! && cmp(c.code, code) < 0),
  ).length;
  return decileOf(rank, n);
}

// ---------------------------------------------------------------------------------------------
// Mapping a plan onto a control (ARN-004, M3 mapControlExits)
// ---------------------------------------------------------------------------------------------

const ANCHORED_RULES: Readonly<Record<string, readonly string[]>> = {
  F2: ["F2.cs_event_low"],
  F3: ["F3.is_event_low"],
};

/**
 * The family's exit plan for a control entering at `entryOpenMicro` with ATR `atrMicro`: own rules
 * only (contributor rules of an F6 signal are event-dependent and become the time stop, which the
 * plan already carries); ATR stops keep their multiple on the control's own ATR; event-anchored
 * levels (F3 initial stop, F2 close below the event low) are rebuilt from the signal's distance in
 * ATR units; polarity-event exits are dropped in favour of the time stop. Returns null when the
 * mapped level cannot be built (non-positive stop).
 */
export function mapPlanForControl(input: {
  readonly family: Family;
  readonly plan: ExitPlan;
  readonly entryOpenMicro: bigint;
  readonly atrMicro: bigint;
  readonly anchors: readonly EventAnchor[];
}): ExitPlan | null {
  const { family, plan, anchors } = input;
  const events: Record<string, { distanceMicro: bigint; atrMicro: bigint }> = {};
  for (const id of ANCHORED_RULES[family] ?? []) {
    const a = anchors.find((x) => x.ruleId === id);
    events[id] = a ?? { distanceMicro: 0n, atrMicro: input.atrMicro };
  }
  let mapped: MappedExit[];
  try {
    mapped = mapControlExits({
      family: family as FamilyId,
      entryDayOpenMicro: input.entryOpenMicro,
      atr20Micro: input.atrMicro,
      events,
    });
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
  const anchorId = ANCHORED_RULES[family]?.[0];
  const found = mapped.find((x) => x.ruleId === anchorId);
  const mappedLevel: bigint | null =
    found !== undefined && found.kind === "atr_level" ? found.levelMicro : null;
  const initialStops: InitialStopRule[] = [];
  for (const r of plan.initialStops) {
    if (r.via !== null) continue;
    const s: StopSpec = r.spec;
    if (s.level_micro !== null && mappedLevel === null) return null;
    initialStops.push({
      id: r.id,
      via: null,
      spec: {
        atr_micro: s.k === null ? null : input.atrMicro,
        k: s.k,
        cap: s.cap,
        level_micro: s.level_micro === null ? null : mappedLevel,
      },
    });
  }
  const trails = plan.trails.filter((t) => t.via === null);
  const cs: CsRule[] = [];
  for (const r of plan.cs) {
    if (r.via !== null || r.kind === "negative_event") continue;
    if (r.kind === "close_below_level") {
      if (mappedLevel !== null) cs.push({ ...r, levelMicro: mappedLevel });
    } else cs.push(r);
  }
  return { initialStops, trails, cs };
}

// ---------------------------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------------------------

type Outcome = {
  readonly code: string;
  readonly entryD: string;
  readonly exitD: string;
  readonly netNum: bigint;
  readonly netDen: bigint;
  readonly stressNum: bigint;
  readonly stressDen: bigint;
  readonly forced: boolean;
};

export type ControlLibrary = {
  draw(req: ControlRequest): ControlDraw;
  /** Number of memoised control paths (a size indicator for the compute report). */
  readonly memoSize: () => number;
};

export function createControlLibrary(
  src: ControlSource,
  cost: CostSetup,
  masterSeed: bigint,
): ControlLibrary {
  const memo = new Map<string, Outcome | null>();
  const universeMemo = new Map<string, readonly PoolCode[]>();
  const decileMemo = new Map<string, Map<string, number>>();

  const universeOf = (d: string, family: Family): readonly PoolCode[] => {
    const k = `${d}|${family}`;
    let u = universeMemo.get(k);
    if (u === undefined) {
      u = [...src.controlUniverse(d, family)].sort((a, b) => cmp(a.code, b.code));
      universeMemo.set(k, u);
    }
    return u;
  };
  const decilesOf = (d: string, family: Family, tier: Tier): Map<string, number> => {
    const k = `${d}|${family}|${tier}`;
    let m = decileMemo.get(k);
    if (m === undefined) {
      m = tierDeciles(universeOf(d, family), tier);
      decileMemo.set(k, m);
    }
    return m;
  };

  const outcomeOf = (req: ControlRequest, c: PoolCode): Outcome | null => {
    const entryD = src.sessions[req.entryIdx];
    if (entryD === undefined || c.atrMicro === null) return null;
    const own = src.bar(c.code, entryD);
    if (own === null) return null;
    const plan = mapPlanForControl({
      family: req.family,
      plan: req.plan,
      entryOpenMicro: own.open,
      atrMicro: c.atrMicro,
      anchors: req.anchors,
    });
    if (plan === null) return null;
    const key = `${req.family}|${c.code}|${req.entryIdx}|${familyOutputJson(plan)}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    const w = walkPosition(
      src,
      {
        code: c.code,
        plan,
        entryIdx: req.entryIdx,
        endIdx: req.endIdx,
        advMicro: c.advMicro,
        maxOpenMicro: null,
        forceExit: true,
      },
      cost,
    );
    let result: Outcome | null = null;
    if (w.kind === "filled") {
      const e = economicsOf(w as WalkFilled);
      if (e !== null && w.exit !== null) {
        result = {
          code: c.code,
          entryD: w.entryD,
          exitD: w.exit.d,
          netNum: e.net.num,
          netDen: e.net.den,
          stressNum: e.stress.num,
          stressDen: e.stress.den,
          forced: w.forced,
        };
      }
    }
    memo.set(key, result);
    return result;
  };

  const draw = (req: ControlRequest): ControlDraw => {
    const decisionD = src.sessions[req.decisionIdx];
    const empty = (note: string, decile: number | null, poolSize: number): ControlDraw => ({
      controls: [],
      forcedIdx: [],
      poolSize,
      usableSize: 0,
      withReplacement: false,
      decile,
      note,
    });
    if (decisionD === undefined) return empty("no_decision_session", null, 0);
    const universe = universeOf(decisionD, req.family);
    const decile = signalDecile(universe, req.tier, req.signalCode);
    if (decile === null) return empty("signal_not_in_universe", null, 0);
    const deciles = decilesOf(decisionD, req.family, req.tier);
    const pool = universe.filter(
      (c) =>
        c.tier === req.tier &&
        deciles.get(c.code) === decile &&
        !req.excludeCodes.has(c.code) &&
        c.code !== req.signalCode,
    );
    if (pool.length === 0) return empty("empty_pool", decile, 0);
    const rng = createPrng(deriveRngSeed(masterSeed, `lib:${req.lineage}:${req.rowId}`));
    const order = pool.slice();
    const usable: Outcome[] = [];
    for (let k = 0; k < order.length && usable.length < req.count; k += 1) {
      const j = k + Number(rng.below(BigInt(order.length - k)));
      const tmp = order[k]!;
      order[k] = order[j]!;
      order[j] = tmp;
      const o = outcomeOf(req, order[k]!);
      if (o !== null) usable.push(o);
    }
    if (usable.length === 0) return empty("no_usable_control", decile, pool.length);
    const chosen: Outcome[] = usable.slice(0, req.count);
    const withReplacement = chosen.length < req.count;
    if (withReplacement) {
      const base = usable.slice();
      while (chosen.length < req.count) chosen.push(base[Number(rng.below(BigInt(base.length)))]!);
    }
    const forcedIdx: number[] = [];
    const controls = chosen.map((o, i): LedgerControlRecord => {
      if (o.forced) forcedIdx.push(i + 1);
      return {
        row_id: req.rowId,
        idx: i + 1,
        code: o.code,
        entry_d: o.entryD,
        exit_d: o.exitD,
        net_num: o.netNum,
        net_den: o.netDen,
        stress_num: o.stressNum,
        stress_den: o.stressDen,
      };
    });
    return {
      controls,
      forcedIdx,
      poolSize: pool.length,
      usableSize: usable.length,
      withReplacement,
      decile,
      note: null,
    };
  };

  return { draw, memoSize: () => memo.size };
}
