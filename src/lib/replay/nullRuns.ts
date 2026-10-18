// AT-17 null runs and injected-edge runs (M4 T16; docs/M4_design.md 4.9; decisions 24, 27, 31).
//
// Two sources of rows feed the same ARN-081 test (`bootstrapSeries`: studentised mean paired excess,
// circular block bootstrap over entry sessions, one-sided p = (1 + #{t* >= t}) / (B + 1)):
//   - synthetic rows (CI and the "injected" kind): per entry session each of `codes` synthetic codes is
//     a signal with probability q (PRNG `null:<run>:signals`); the row and its `controls` matched
//     controls take their returns from ONE pool of synthetic fat-tailed returns that is PERMUTED
//     (`null:<run>:perm`), so under the null the row is exchangeable with its controls and the mean
//     paired excess is exactly 0. Injected runs add a known edge to the row returns only;
//   - real-data rows (`realNullRun`, Owner-approved production run, decision 31): a random-signal "family"
//     on the real snapshot (PRNG `null:<run>:<session index>`), the F1 exit plan, the same control
//     library, through the signal-ledger replay.
// Pass rule (AT-17): rejection counts at 0.05 and 0.01 inside the exact two-sided 99 % binomial
// acceptance region for n runs, and the lower-tail p-values (p / 0.10 for p <= 0.10) not rejected as
// uniform by the KS test at 0.01. The size extrapolated to the working levels is reported, not a pass
// condition. Pure and deterministic: no clock, no Math.random.
import type { Candidate } from "@/lib/agents/families";
import { f1Plan } from "@/lib/agents/families/exits";
import { FAMILY_RULE_VERSION } from "@/lib/agents/families/constants";
import type { AgentParams } from "@/lib/agents/params";
import { makeRational } from "@/lib/money/rational";
import { binomialAcceptanceRegion, clopperPearson } from "@/lib/stats/binomial";
import { bootstrapSeries, MIN_INDEPENDENT_BLOCKS, percentile } from "@/lib/stats/bootstrap";
import { bootstrapReplications, validationLevel } from "@/lib/stats/gates";
import { ksUniformityTest } from "@/lib/stats/ks";
import { normalQuantile } from "@/lib/stats/normal";
import { belowInt, scopedPrng, uniform01 } from "@/lib/stats/rng";
import { replayLedger, type LedgerResult, type LedgerSource } from "./ledger";
import type { PoolCode } from "./controlLibrary";

export type SyntheticSpec = {
  /** Entry sessions S in the tested window. */
  readonly sessions: number;
  /** Synthetic codes per session; each is a signal with probability `q`. */
  readonly codes: number;
  readonly q: number;
  /** Matched controls per row (c2_controls_per_row). */
  readonly controls: number;
  /** Net-return SD of one trade (the pool's scale). */
  readonly sd: number;
  /** Bootstrap block length in sessions. */
  readonly block: number;
};

/** About 240 rows over 300 sessions with block 5 (60 independent blocks), 20 controls per row. */
export const DEFAULT_SPEC: SyntheticSpec = {
  sessions: 300, // threshold-ok: synthetic AT-17 test window, not a config key
  codes: 40, // threshold-ok: synthetic codes per session
  q: 0.02, // threshold-ok: expected rows per session = 0.8
  controls: 20, // threshold-ok: c2_controls_per_row default (ch15 l.56)
  sd: 0.05, // threshold-ok: synthetic per-trade SD
  block: 5, // threshold-ok: bootstrap_block floor (ch15 l.60)
};

/**
 * Injected runs: a longer window (about 480 rows) and a 3.5 % per-trade SD (design 4.9 leaves the
 * noise open), so the +1.5 % edge is detectable at 0.000417 with B = 48,000.
 */
export const INJECTED_SPEC: SyntheticSpec = { ...DEFAULT_SPEC, sessions: 600, sd: 0.035 }; // threshold-ok: synthetic window and noise

/** The known edge of the injected runs: +1.5 % net over the matched controls (design 4.9). */
export const INJECTED_EDGE = 0.015; // threshold-ok: AT-17 injected edge (decision 24 / design 4.9)

export type ExcessRow = { readonly session: number; readonly excess: number };

/** Fat-tailed standard deviate: a normal with a 3x scale on one draw in ten. */
function deviate(rng: ReturnType<typeof scopedPrng>): number {
  const u = Math.min(1 - 1e-12, Math.max(1e-12, uniform01(rng))); // threshold-ok: numeric-stability clamp on the quantile argument
  const z = normalQuantile(u);
  return uniform01(rng) < 0.1 ? 3 * z : z; // threshold-ok: tail mixture of the synthetic pool
}

/** The rows of one synthetic run: entry sessions from the signal draw, excess from permuted returns. */
export function syntheticRows(
  kind: "null" | "injected",
  run: number,
  spec: SyntheticSpec,
  edge: number,
  masterSeed?: bigint,
): ExcessRow[] {
  const sig = scopedPrng(`${kind}:${run}:signals`, masterSeed);
  const sessionsOfRows: number[] = [];
  for (let s = 0; s < spec.sessions; s += 1) {
    for (let c = 0; c < spec.codes; c += 1) if (uniform01(sig) < spec.q) sessionsOfRows.push(s);
  }
  const per = spec.controls + 1;
  const pool = scopedPrng(`${kind}:${run}:pool`, masterSeed);
  const values: number[] = [];
  for (let i = 0; i < sessionsOfRows.length * per; i += 1) values.push(spec.sd * deviate(pool));
  // Permute the pooled returns (Fisher-Yates), then deal them out: slot 0 of a group is the row.
  const perm = scopedPrng(`${kind}:${run}:perm`, masterSeed);
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = belowInt(perm, i + 1);
    const t = values[i]!;
    values[i] = values[j]!;
    values[j] = t;
  }
  return sessionsOfRows.map((session, r) => {
    let controls = 0;
    for (let k = 1; k < per; k += 1) controls += values[r * per + k]!;
    return { session, excess: values[r * per]! + edge - controls / spec.controls };
  });
}

export type RunTest = {
  readonly run: number;
  readonly rows: number;
  readonly blocks: number;
  readonly insufficientBlocks: boolean;
  readonly mean: number;
  readonly se: number;
  readonly p: number;
  readonly B: number;
};

/** The ARN-081 one-sided studentised test of one run's rows at `B` replicates. */
export function testRows(
  kind: "null" | "injected",
  run: number,
  rows: readonly ExcessRow[],
  sessionCount: number,
  block: number,
  B: number,
  masterSeed?: bigint,
): RunTest {
  const rng = scopedPrng(`boot:${kind}:${run}`, masterSeed);
  const sm = bootstrapSeries(
    rows.map((r) => r.session),
    rows.map((r) => r.excess),
    sessionCount,
    block,
    B,
    rng,
  );
  return {
    run,
    rows: rows.length,
    blocks: sm.blocks,
    insufficientBlocks: sm.insufficientBlocks,
    mean: sm.test.mean,
    se: sm.test.se,
    p: sm.test.p,
    B,
  };
}

// ---- batches --------------------------------------------------------------------------------------

export type BatchOptions = {
  readonly runs: number;
  readonly spec?: SyntheticSpec;
  /** Bootstrap replicates (reduced B is allowed only for the size checks, decision 24: 2,000). */
  readonly B: number;
  readonly masterSeed?: bigint;
  /** Polled before each run; true stops the batch cleanly (paused_budget). */
  readonly shouldStop?: () => boolean;
};

export type Batch = {
  readonly kind: "null" | "injected";
  readonly tests: readonly RunTest[];
  readonly requested: number;
  readonly pausedBudget: boolean;
};

export function syntheticBatch(kind: "null" | "injected", o: BatchOptions): Batch {
  const spec = o.spec ?? (kind === "injected" ? INJECTED_SPEC : DEFAULT_SPEC);
  const edge = kind === "injected" ? INJECTED_EDGE : 0;
  const tests: RunTest[] = [];
  let paused = false;
  for (let run = 0; run < o.runs; run += 1) {
    if (o.shouldStop?.() === true) {
      paused = true;
      break;
    }
    const rows = syntheticRows(kind, run, spec, edge, o.masterSeed);
    tests.push(testRows(kind, run, rows, spec.sessions, spec.block, o.B, o.masterSeed));
  }
  return { kind, tests, requested: o.runs, pausedBudget: paused };
}

// ---- reports --------------------------------------------------------------------------------------

export const SIZE_LEVELS: readonly number[] = [0.05, 0.01]; // threshold-ok: AT-17 size-check levels
const ACCEPT_ALPHA = 0.01; // threshold-ok: 99 % binomial acceptance bounds (AT-17)
export const UNIFORM_ALPHA = 0.01; // threshold-ok: KS uniformity level (decision 27)
/** Minimum active lineages assumed by the validation level (spec ch.15 active-lineages floor). */
export const LINEAGES_FLOOR_MIN = 6; // threshold-ok: validation-level lineage floor, ch.15 active_lineages_floor — no separate key yet (D-095)
const LOWER_TAIL = 0.1; // threshold-ok: lower-tail window of the uniformity check

export type SizeLevel = {
  readonly level: number;
  readonly rejections: number;
  readonly rate: number;
  readonly lo: number;
  readonly hi: number;
  readonly within: boolean;
};

export type Extrapolated = {
  readonly level: number;
  readonly rejections: number;
  readonly rate: number;
  readonly lower: number;
  readonly upper: number;
};

export type SizeReport = {
  /** Runs counted (insufficient-block runs excluded). */
  readonly n: number;
  readonly insufficient: number;
  readonly levels: readonly SizeLevel[];
  readonly uniformity: {
    readonly n: number;
    readonly d: number;
    readonly p: number;
    readonly pass: boolean;
  };
  /** Empirical rate and Clopper-Pearson 99 % interval at the working levels: reported, not a pass condition. */
  readonly extrapolated: readonly Extrapolated[];
  readonly pass: boolean;
};

export function sizeReport(tests: readonly RunTest[], params: AgentParams): SizeReport {
  const used = tests.filter((t) => !t.insufficientBlocks);
  const ps = used.map((t) => t.p);
  const n = ps.length;
  const levels: SizeLevel[] = SIZE_LEVELS.map((level) => {
    const k = ps.filter((p) => p <= level).length;
    const { lo, hi } = binomialAcceptanceRegion(n, level, ACCEPT_ALPHA);
    return { level, rejections: k, rate: n === 0 ? 0 : k / n, lo, hi, within: k >= lo && k <= hi };
  });
  const lower = ps.filter((p) => p <= LOWER_TAIL).map((p) => p / LOWER_TAIL);
  const ks = lower.length === 0 ? { n: 0, d: 0, p: 0 } : ksUniformityTest(lower);
  const uniformity = { ...ks, pass: lower.length > 0 && ks.p >= UNIFORM_ALPHA };
  const L = Math.max(params.stats.activeLineagesFloor, LINEAGES_FLOOR_MIN);
  const working = [
    params.stats.alpha / params.stats.trialBudgetPerLineage,
    validationLevel(params.stats.alpha, params.stats.trialBudgetPerLineage, L),
  ];
  const extrapolated = working.map((level): Extrapolated => {
    const k = ps.filter((p) => p <= level).length;
    const ci = n === 0 ? { lower: 0, upper: 1 } : clopperPearson(k, n, ACCEPT_ALPHA);
    return { level, rejections: k, rate: n === 0 ? 0 : k / n, lower: ci.lower, upper: ci.upper };
  });
  return {
    n,
    insufficient: tests.length - n,
    levels,
    uniformity,
    extrapolated,
    pass: n > 0 && levels.every((l) => l.within) && uniformity.pass,
  };
}

export type DetectionReport = {
  readonly n: number;
  readonly level: number;
  readonly detected: number;
  readonly rate: number;
  /** The stated power (80 %, ARN-081 MDE). */
  readonly power: number;
  readonly pass: boolean;
  readonly medianMean: number | null;
};

/** Detection rate of the injected-edge runs at `level` against the stated power. */
export function detectionReport(
  tests: readonly RunTest[],
  level: number,
  power: number,
): DetectionReport {
  const used = tests.filter((t) => !t.insufficientBlocks);
  const detected = used.filter((t) => t.p <= level).length;
  const rate = used.length === 0 ? 0 : detected / used.length;
  return {
    n: used.length,
    level,
    detected,
    rate,
    power,
    pass: used.length > 0 && rate >= power,
    medianMean:
      used.length === 0
        ? null
        : percentile(
            used.map((t) => t.mean),
            0.5, // threshold-ok: median
          ),
  };
}

/** "< 15 blocks" window: the result must say "insufficient independent blocks" (ARN-081). */
export function fewBlocksCheck(spec: SyntheticSpec = DEFAULT_SPEC): RunTest {
  const sessions = spec.block * (MIN_INDEPENDENT_BLOCKS - 1);
  const small: SyntheticSpec = { ...spec, sessions };
  return testRows(
    "injected",
    0,
    syntheticRows("injected", 0, small, INJECTED_EDGE),
    sessions,
    spec.block,
    1000, // threshold-ok: bootstrap replicates of the few-blocks check, ARN-081 (no ch.15 key; D-095)
  );
}

/** The validation level and replicate count of the committed-seed injected run (0.000417, 48,000). */
export function workingLevel(params: AgentParams): { level: number; B: number } {
  const L = Math.max(params.stats.activeLineagesFloor, LINEAGES_FLOOR_MIN);
  const level = validationLevel(params.stats.alpha, params.stats.trialBudgetPerLineage, L);
  return { level, B: bootstrapReplications(level) };
}

// ---- real-data random-signal null (production, decision 31) -----------------------------------------

/**
 * A LedgerSource whose F1-shaped signals are random: on every session each eligible U1 code of the
 * control universe is a signal with probability `q` (PRNG `null:<run>:<session index>`, consumed in
 * code order). Everything else (bars, facts, controls, exits) is the real snapshot's.
 */
export function randomSignalSource(
  world: LedgerSource & { readonly market?: string },
  o: {
    readonly run: number;
    readonly q: number;
    readonly params: AgentParams;
    readonly masterSeed?: bigint;
  },
): LedgerSource {
  const sessions = world.sessions;
  const index = new Map(sessions.map((d, i) => [d, i]));
  return {
    ...world,
    sessions,
    market: world.market ?? "AU",
    bar: (c, d) => world.bar(c, d),
    positionFacts: (c, d) => world.positionFacts(c, d),
    corpActions: world.corpActions === undefined ? undefined : (c) => world.corpActions!(c),
    controlUniverse: (d, f) => world.controlUniverse(d, f),
    familyInputs: (d) => world.familyInputs(d),
    familyOutput(d) {
      const i = index.get(d);
      if (i === undefined) return null;
      const rng = scopedPrng(`null:${o.run}:${i}`, o.masterSeed);
      const pool: readonly PoolCode[] = [...world.controlUniverse(d, "F1")]
        .filter((u) => u.eligible && u.tier === "U1" && u.atrMicro !== null)
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      const candidates: Candidate[] = [];
      for (const u of pool) {
        if (uniform01(rng) >= o.q) continue;
        const plan = f1Plan(o.params, u.atrMicro);
        candidates.push({
          d,
          family: "F1",
          variant: "F1-U1",
          ruleVersion: FAMILY_RULE_VERSION.F1,
          code: u.code,
          tier: "U1",
          regime: "unknown",
          halfSize: false,
          rank: [],
          rankText: "random",
          adv: u.advMicro === 0n ? null : makeRational(u.advMicro),
          groupKey: null,
          classes: null,
          contributors: [],
          maxOpenMicro: null,
          stopSpec: plan.initialStops[0]!.spec,
          plan,
          rules: [],
          flags: ["random-signal"],
        });
      }
      return { candidates, blocked: [] };
    },
  };
}

/** Closed ledger rows with controls as test rows (entry session relative to the first entry). */
export function ledgerTestRows(
  result: LedgerResult,
  sessions: readonly string[],
): {
  rows: ExcessRow[];
  sessionCount: number;
  holds: number[];
} {
  const idx = new Map(sessions.map((d, i) => [d, i]));
  const closed = result.entries.filter((e) => e.excess !== null && e.row.exit_d !== null);
  if (closed.length === 0) return { rows: [], sessionCount: 1, holds: [] };
  const first = Math.min(...closed.map((e) => idx.get(e.row.entry_d)!));
  const last = Math.max(...closed.map((e) => idx.get(e.row.entry_d)!));
  const rows = closed.map((e) => ({
    session: idx.get(e.row.entry_d)! - first,
    excess: Number(e.excess!.num) / Number(e.excess!.den),
  }));
  const holds = closed.map((e) => idx.get(e.row.exit_d!)! - idx.get(e.row.entry_d)!);
  return { rows, sessionCount: last - first + 1, holds };
}

export type RealNullOptions = {
  readonly world: LedgerSource & { readonly market?: string };
  readonly params: AgentParams;
  readonly runs: number;
  readonly q: number;
  readonly B: number;
  readonly masterSeed?: bigint;
  readonly shouldStop?: () => boolean;
};

/** Block length = max(floor, p75 of the realised holding sessions) (ARN-081). */
export function blockOf(holds: readonly number[], params: AgentParams): number {
  if (holds.length === 0) return params.stats.bootstrapBlockMinSessions;
  return Math.max(
    params.stats.bootstrapBlockMinSessions,
    percentile(holds, params.stats.bootstrapBlockPercentile),
  );
}

/** Random-signal null runs on the real snapshot: ledger with controls, then the ARN-081 test. */
export function realNullBatch(o: RealNullOptions): Batch {
  const tests: RunTest[] = [];
  let paused = false;
  for (let run = 0; run < o.runs; run += 1) {
    if (o.shouldStop?.() === true) {
      paused = true;
      break;
    }
    const src = randomSignalSource(o.world, {
      run,
      q: o.q,
      params: o.params,
      masterSeed: o.masterSeed,
    });
    const result = replayLedger(src, { params: o.params, masterSeed: o.masterSeed });
    const t = ledgerTestRows(result, o.world.sessions);
    if (t.rows.length === 0) continue;
    tests.push(
      testRows("null", run, t.rows, t.sessionCount, blockOf(t.holds, o.params), o.B, o.masterSeed),
    );
  }
  return { kind: "null", tests, requested: o.runs, pausedBudget: paused };
}

/** Expected rows per session -> q so the random family's row count matches a measured rate. */
export function matchedQ(rows: number, eligibleSessionCodes: number): number {
  if (eligibleSessionCodes <= 0) return 0;
  return Math.min(1, rows / eligibleSessionCodes);
}
