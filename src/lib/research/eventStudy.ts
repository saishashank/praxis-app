// Research engine, event study (M23 R1; D-1605, D-1610, D-1626, D-1627, D-1628, D-1655). Pure, no database, seeded.
//
// A lineage is a list of setups (code, signal session, hold). Each is entered at the open after its signal session and
// left at the open `hold` sessions later (a time exit unless the lineage adds a stop), net of the fees of a named cost
// profile at a parcel, in parts per million of the entry value. Its excess is the net minus the mean net of up to k
// matched controls of the same session, run through the same rule. The statistic is the mean excess after the
// survivorship haircut with its one-sided block-bootstrap lower bound at level 1 - alpha (alpha = 0.10 / k, Bonferroni
// across the base lineages that reach a look, D-1628); block = the hold.
//
// Order of work (D-1605): the entries are counted FIRST (setups after the one-open-position-per-code rule, distinct
// sessions, blocks). If a floor is not met the function returns `below_sample` having touched no price. Only then are
// prices read. A statistic that cannot be computed is an INCONCLUSIVE verdict (the look is spent, D-1605).
import { makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { percentile } from "@/lib/stats/bootstrap";
import { scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";
import { meanStatistic, stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import { matchControls, type ControlCandidate, type ControlPool, type MatchKey } from "./controls";
import { haircutPpm, simulateTrade, type CostFn, type HaircutRule, type Micro } from "./costs";
import { entrySessionOf, resolveExit, TIME_EXIT, type ExitRule, type PriceBook } from "./exits";

/** The three words a research look can end in (D-1602). */
export type EngineVerdict = "PASS" | "NULL" | "INCONCLUSIVE";

/** The family-wise one-sided level of CXA-003 (D-1628: 1 - 0.10 / k). */
export const FAMILY_ALPHA = 0.1; // threshold-ok: D-1628 one-sided 90 % family level
export const DEFAULT_REPLICATES = 2000; // threshold-ok: research bootstrap replicates (stats default)

/** Bonferroni: the per-lineage tail probability when `k` base lineages reach a look (k >= 1). */
export function bonferroniAlpha(k: number, familyAlpha: number = FAMILY_ALPHA): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError("k must be a positive integer");
  return familyAlpha / k;
}

export type Setup = {
  readonly code: string;
  /** Session index of the signal; entry is at the next open. */
  readonly signalSession: number;
  /** Sessions held; the exit is the open `hold` sessions after the entry open. */
  readonly hold: number;
  readonly tier?: string;
  readonly volDecile?: number;
};

export type Floors = {
  readonly minSetups: number;
  readonly minBlocks: number;
  /** Optional; omitted means no floor on distinct sessions. */
  readonly minSessions?: number;
};

export type EventStudyParams = {
  /** Lineage key, used only to scope the random draws. */
  readonly lineage: string;
  readonly parcelMicro: Micro;
  readonly cost: CostFn;
  readonly floors: Floors;
  /** Defaults to the time exit. */
  readonly exit?: ExitRule;
  /** Survivorship haircut per hold; null is none. */
  readonly haircut: HaircutRule | null;
  /** Matching keys for the controls; empty with a pool means "any code of the session". */
  readonly matchOn?: readonly MatchKey[];
  /** At most this many controls per setup (default 20, D-1627). */
  readonly maxControls?: number;
  /** One-sided tail probability of the lower bound (0.10 / k). Default 0.10. */
  readonly alpha?: number;
  readonly replicates?: number;
  readonly masterSeed?: bigint;
};

export type EventStudyEnv = {
  readonly prices: PriceBook;
  /** Without a pool the excess is the net itself (control "none"). */
  readonly pool?: ControlPool;
};

/** Entry counts, taken before any outcome is read (D-1605). */
export type EntryCounts = {
  readonly setups: number;
  readonly sessions: number;
  readonly blocks: number;
  /** Block length in sessions: the longest hold. */
  readonly blockSessions: number;
};

export type SetupRow = {
  readonly code: string;
  readonly signalSession: number;
  readonly hold: number;
  readonly netPpm: number;
  readonly controlPpm: number | null;
  readonly controls: number;
  readonly excessPpm: number;
  readonly afterHaircutPpm: number;
};

export type Statistic = {
  readonly n: number;
  readonly meanPpm: number;
  /** One-sided lower bound at tail probability `alpha`; null when the bootstrap is undefined. */
  readonly lowerPpm: number | null;
  readonly alpha: number;
};

export type EventStudyResult =
  | {
      readonly status: "below_sample";
      readonly counts: EntryCounts;
      readonly floors: Floors;
      readonly reason: string;
    }
  | {
      readonly status: "looked";
      readonly verdict: EngineVerdict;
      readonly reason: string;
      readonly counts: EntryCounts;
      readonly floors: Floors;
      /** Setups whose prices were missing. */
      readonly unfilled: number;
      /** Setups with no matched control. */
      readonly unmatched: number;
      readonly parcelMicro: string;
      /** Mean net over the setups used (ppm). */
      readonly meanNetPpm: number;
      /** The primary statistic: mean excess after the haircut. */
      readonly withHaircut: Statistic;
      /** The same excess without the haircut (reported, never the gate). */
      readonly withoutHaircut: Statistic;
      readonly rows: readonly SetupRow[];
    };

const byEntry = (a: Setup, b: Setup): number =>
  a.signalSession - b.signalSession || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/**
 * One open position per code per lineage at a time (D-1627): a setup whose entry falls before the scheduled exit of the
 * previous accepted setup of the same code is dropped. Decided on entries alone (a stop could free the code earlier but
 * is not known before outcomes, so the schedule is used).
 */
export function oneOpenPerCode(setups: readonly Setup[]): Setup[] {
  const out: Setup[] = [];
  const freeAt = new Map<string, number>();
  for (const s of setups.slice().sort(byEntry)) {
    const entry = entrySessionOf(s.signalSession);
    if (entry < (freeAt.get(s.code) ?? Number.NEGATIVE_INFINITY)) continue;
    freeAt.set(s.code, entry + s.hold);
    out.push(s);
  }
  return out;
}

/** Setups, distinct signal sessions and blocks (floor(signal / longest hold)) of a setup list: no price is read. */
export function countEntries(setups: readonly Setup[]): EntryCounts {
  let blockSessions = 1;
  for (const s of setups) if (s.hold > blockSessions) blockSessions = s.hold;
  const sessions = new Set<number>();
  const blocks = new Set<number>();
  for (const s of setups) {
    sessions.add(s.signalSession);
    blocks.add(Math.floor(s.signalSession / blockSessions));
  }
  return { setups: setups.length, sessions: sessions.size, blocks: blocks.size, blockSessions };
}

/** First floor not met, in words, or null (counts only). */
export function floorShortfall(c: EntryCounts, f: Floors): string | null {
  if (c.setups < f.minSetups) return `${c.setups} setups, the floor is ${f.minSetups}`;
  if (c.blocks < f.minBlocks) return `${c.blocks} blocks, the floor is ${f.minBlocks}`;
  if (f.minSessions !== undefined && c.sessions < f.minSessions)
    return `${c.sessions} sessions, the floor is ${f.minSessions}`;
  return null;
}

/** Split setups at a signal-session boundary: development before it, holdout from it (D-1628). */
export function splitSetups(
  setups: readonly Setup[],
  boundarySignalSession: number,
): { development: Setup[]; holdout: Setup[] } {
  return {
    development: setups.filter((s) => s.signalSession < boundarySignalSession),
    holdout: setups.filter((s) => s.signalSession >= boundarySignalSession),
  };
}

/**
 * The one-sided lower bound of a mean at tail probability `alpha`: the alpha-quantile of the stationary block-bootstrap
 * replicate means (expected block `block`, floor `maxHold`). Undefined (null) when no rows.
 */
export function blockLowerBound(input: {
  readonly sessions: readonly number[];
  readonly sessionCount: number;
  readonly values: readonly number[];
  readonly block: number;
  readonly alpha: number;
  readonly scope: string;
  readonly replicates?: number;
  readonly masterSeed?: bigint;
}): number | null {
  const { sessions, sessionCount, values, block, alpha } = input;
  if (values.length === 0) return null;
  if (!(alpha > 0 && alpha < 1)) throw new RangeError("alpha must be inside (0, 1)");
  const rng = scopedPrng(input.scope, input.masterSeed ?? STATS_MASTER_SEED);
  const r = stationaryBlockBootstrap({ sessions, sessionCount }, meanStatistic(values), rng, {
    expectedBlock: block,
    maxHold: block,
    replicates: input.replicates ?? DEFAULT_REPLICATES,
  });
  const lower = percentile(r.values, alpha);
  return Number.isFinite(lower) ? lower : null;
}

function meanOf(values: readonly bigint[]): bigint {
  let sum = 0n;
  for (const v of values) sum += v;
  return roundHalfAwayFromZero(makeRational(sum, BigInt(values.length)));
}

/**
 * Run one setup list. `setups` are used as given after the one-open-position rule; the caller splits windows. A second
 * parcel runs the same setups again with a different `parcelMicro` (only the fees change, D-1627 sensitivity).
 */
export function eventStudy(
  setups: readonly Setup[],
  env: EventStudyEnv,
  p: EventStudyParams,
): EventStudyResult {
  // 1. Count the entries; below a floor nothing else is touched (no price accessor call).
  const accepted = oneOpenPerCode(setups);
  const counts = countEntries(accepted);
  const shortfall = floorShortfall(counts, p.floors);
  if (shortfall !== null) {
    return { status: "below_sample", counts, floors: p.floors, reason: shortfall };
  }

  const exitRule = p.exit ?? TIME_EXIT;
  const matchOn = p.matchOn ?? [];
  const maxControls = p.maxControls ?? 20; // threshold-ok: D-1627 up to 20 matched controls
  const alpha = p.alpha ?? FAMILY_ALPHA;
  const seed = p.masterSeed ?? STATS_MASTER_SEED;

  // 2. Prices are read from here on.
  const net = (code: string, signalSession: number, hold: number): bigint | undefined => {
    const entrySession = entrySessionOf(signalSession);
    const entry = env.prices.open(code, entrySession);
    if (entry === undefined || entry <= 0n) return undefined;
    const exit = resolveExit({
      rule: exitRule,
      code,
      entrySession,
      hold,
      entryMicro: entry,
      prices: env.prices,
    });
    if (exit === undefined || exit.priceMicro <= 0n) return undefined;
    return simulateTrade({
      code,
      entryMicro: entry,
      exitMicro: exit.priceMicro,
      parcelMicro: p.parcelMicro,
      cost: p.cost,
    }).netPpm;
  };

  const rows: SetupRow[] = [];
  const sessions: number[] = [];
  const withValues: number[] = [];
  const withoutValues: number[] = [];
  let withSum = 0n;
  let withoutSum = 0n;
  let netSum = 0n;
  let unfilled = 0;
  let unmatched = 0;

  for (const s of accepted) {
    const own = net(s.code, s.signalSession, s.hold);
    if (own === undefined) {
      unfilled += 1;
      continue;
    }
    let controlPpm: bigint | null = null;
    let controlCount = 0;
    if (env.pool !== undefined) {
      const subject: ControlCandidate = { code: s.code, tier: s.tier, volDecile: s.volDecile };
      const picked = matchControls({
        subject,
        pool: env.pool(entrySessionOf(s.signalSession)),
        matchOn,
        k: maxControls,
        scope: `research:${p.lineage}:ctrl:${s.code}:${s.signalSession}`,
        masterSeed: seed,
      });
      const nets: bigint[] = [];
      for (const c of picked) {
        const v = net(c.code, s.signalSession, s.hold);
        if (v !== undefined) nets.push(v);
      }
      if (nets.length === 0) {
        unmatched += 1;
        continue;
      }
      controlPpm = meanOf(nets);
      controlCount = nets.length;
    }
    const excess = own - (controlPpm ?? 0n);
    const after = excess - haircutPpm(s.hold, p.haircut);
    netSum += own;
    withSum += after;
    withoutSum += excess;
    withValues.push(Number(after));
    withoutValues.push(Number(excess));
    sessions.push(entrySessionOf(s.signalSession));
    rows.push({
      code: s.code,
      signalSession: s.signalSession,
      hold: s.hold,
      netPpm: Number(own),
      controlPpm: controlPpm === null ? null : Number(controlPpm),
      controls: controlCount,
      excessPpm: Number(excess),
      afterHaircutPpm: Number(after),
    });
  }

  const n = rows.length;
  if (n === 0) {
    const empty: Statistic = { n: 0, meanPpm: 0, lowerPpm: null, alpha };
    return {
      status: "looked",
      verdict: "INCONCLUSIVE",
      reason: "no setup could be priced and matched, so the statistic is undefined",
      counts,
      floors: p.floors,
      unfilled,
      unmatched,
      parcelMicro: p.parcelMicro.toString(),
      meanNetPpm: 0,
      withHaircut: empty,
      withoutHaircut: empty,
      rows,
    };
  }

  let first = sessions[0]!;
  let last = sessions[0]!;
  for (const s of sessions) {
    if (s < first) first = s;
    if (s > last) last = s;
  }
  const layoutSessions = sessions.map((s) => s - first);
  const sessionCount = last - first + 1;
  const common = {
    sessions: layoutSessions,
    sessionCount,
    block: counts.blockSessions,
    alpha,
    replicates: p.replicates,
    masterSeed: seed,
  };
  const lowerWith = blockLowerBound({
    ...common,
    values: withValues,
    scope: `research:${p.lineage}:boot:with`,
  });
  const lowerWithout = blockLowerBound({
    ...common,
    values: withoutValues,
    scope: `research:${p.lineage}:boot:without`,
  });
  const withHaircut: Statistic = { n, meanPpm: Number(withSum) / n, lowerPpm: lowerWith, alpha };
  const withoutHaircut: Statistic = {
    n,
    meanPpm: Number(withoutSum) / n,
    lowerPpm: lowerWithout,
    alpha,
  };

  let verdict: EngineVerdict;
  let reason: string;
  if (lowerWith === null) {
    verdict = "INCONCLUSIVE";
    reason = "the lower bound could not be computed";
  } else if (lowerWith > 0) {
    verdict = "PASS";
    reason = "the lower bound of the mean excess after the haircut is above zero";
  } else {
    verdict = "NULL";
    reason = "the lower bound of the mean excess after the haircut is not above zero";
  }
  return {
    status: "looked",
    verdict,
    reason,
    counts,
    floors: p.floors,
    unfilled,
    unmatched,
    parcelMicro: p.parcelMicro.toString(),
    meanNetPpm: Number(netSum) / n,
    withHaircut,
    withoutHaircut,
    rows,
  };
}

/** The registry's compute contract (A2 `takeLook`): below sample writes nothing, a verdict writes the look. */
export type LookOutcome =
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly verdict: EngineVerdict;
      readonly nSetups: number;
      readonly nBlocks: number;
      readonly stats: Readonly<Record<string, number | string | null>>;
    };

/** Convert an engine result to the registry's compute return value (aggregates only, no rows, no codes). */
export function lookOutcome(r: EventStudyResult): LookOutcome {
  if (r.status === "below_sample") return { status: "below_sample", reason: r.reason };
  return {
    verdict: r.verdict,
    nSetups: r.withHaircut.n,
    nBlocks: r.counts.blocks,
    stats: {
      meanExcessAfterHaircutPpm: r.withHaircut.meanPpm,
      lowerPpm: r.withHaircut.lowerPpm,
      alpha: r.withHaircut.alpha,
      meanExcessPpm: r.withoutHaircut.meanPpm,
      lowerNoHaircutPpm: r.withoutHaircut.lowerPpm,
      meanNetPpm: r.meanNetPpm,
      sessions: r.counts.sessions,
      unfilled: r.unfilled,
      unmatched: r.unmatched,
      parcelMicro: r.parcelMicro,
    },
  };
}
