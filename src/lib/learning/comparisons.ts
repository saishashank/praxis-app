// Comparisons (M6 T5; ARN-062, EML-037; design 2.5; D-110 #23, D-111, D-114 draft).
//
// Two kinds of statement, kept apart on purpose:
//   - NIGHTLY (kind `nightly`): per pair the difference of means (A - B) with a two-sided interval from
//     a block bootstrap over entry sessions (both sides resampled on the SAME blocks). Always labelled
//     "descriptive - not a finding"; fewer than `comparison_min_rows` rows on a side -> "not enough data".
//   - WEEKLY (kind `weekly`, Saturday's learning run on data up to Friday): every eligible pair gets a
//     two-sided studentised bootstrap p; Benjamini-Hochberg at q = `comparisons_fdr_q` across that
//     week's tests. A discovery becomes a CANDIDATE finding with a direction and a look date. The one
//     confirmation LOOK (kind `look`) runs on rows entered AFTER the detection date, one-sided at
//     `comparison_look_alpha` in the detected direction: pass -> confirmed; fail -> discarded and the
//     pair is locked out for `comparison_lockout_sessions` sessions. Pairs locked out or with an open
//     candidate are not re-tested.
//
// Pure functions compute everything; the `write*`/`read*` functions persist idempotently (INSERT OR
// IGNORE on the primary keys, guarded one-way UPDATE). No clock reads, no Math.random: seeds derive from
// the scope string, so the same inputs give byte-identical rows. Every number comes from AgentParams;
// the session calendar (advancing a date by n sessions) is passed in by the caller (the nightly/weekly
// composition in T11/T12), as this module owns no calendar.
import type { Client, InStatement } from "@libsql/client";
import type { AgentParams } from "../agents/params";
import { mean, percentile, sampleSd } from "../stats/bootstrap";
import { belowInt, scopedPrng, STATS_MASTER_SEED, type Prng } from "../stats/rng";

// ---- labels (text is part of the contract: EML-037 / AT-22 quote it) ----

export const LABEL_DESCRIPTIVE = "descriptive — not a finding";
export const LABEL_WEEKLY_DISCOVERY = "weekly test — discovery (candidate finding)";
export const LABEL_WEEKLY_NONE = "weekly test — no discovery";
export const LABEL_LOOK_PASSED = "confirmation look — passed (finding)";
export const LABEL_LOOK_FAILED = "confirmation look — failed (discarded, locked out)";
export const labelNotEnoughData = (n: number): string => `not enough data (n = ${n})`;
export const labelNoDetectableDifference = (n: number): string =>
  `no detectable difference (n = ${n})`;

// ---- inputs ----

/** One signal-ledger row: its entry-session index in the window (0..S-1) and the compared value. */
export type CompRow = { readonly session: number; readonly value: number };

export type PairData = {
  readonly market: string;
  /** Stable pair id, e.g. `F1.v1|F2.v1`; first side is A, the difference is A - B. */
  readonly pairId: string;
  readonly a: readonly CompRow[];
  readonly b: readonly CompRow[];
  /** Sessions S in the window the rows' session indices refer to. */
  readonly sessionCount: number;
  /** The larger frozen block of the lineages involved (ARN-081). */
  readonly block: number;
};

export type Direction = 1 | -1;

export type ComparisonRow = {
  readonly market: string;
  readonly kind: "nightly" | "weekly" | "look";
  readonly pair_id: string;
  readonly d: string;
  readonly n_a: number;
  readonly n_b: number;
  readonly estimate: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly p: number | null;
  readonly bh_rank: number | null;
  readonly discovery: 0 | 1;
  readonly block: number;
  readonly B: number;
  readonly label: string;
};

// ---- bootstrap of a difference of means ----

export type DiffBootstrap = {
  readonly estimate: number;
  readonly se: number;
  /** Uncentred replicate differences. */
  readonly replicates: Float64Array;
  readonly redraws: number;
};

function checkSide(rows: readonly CompRow[], S: number): void {
  for (const r of rows) {
    if (!Number.isInteger(r.session) || r.session < 0 || r.session >= S)
      throw new RangeError("session out of range");
  }
}

/** Rows grouped by session (CSR), input order inside a session. */
function bySession(
  rows: readonly CompRow[],
  S: number,
): { offsets: Int32Array; values: Float64Array } {
  const offsets = new Int32Array(S + 1);
  for (const r of rows) offsets[r.session + 1]! += 1;
  for (let i = 0; i < S; i += 1) offsets[i + 1]! += offsets[i]!;
  const fill = Int32Array.from(offsets.subarray(0, S));
  const values = new Float64Array(rows.length);
  for (const r of rows) {
    values[fill[r.session]!] = r.value;
    fill[r.session]! += 1;
  }
  return { offsets, values };
}

/**
 * Paired circular block bootstrap of mean(A) - mean(B): each replicate draws ceil(S / block) block
 * starts once and both sides collect the rows in the drawn blocks. A replicate in which either side
 * is empty is redrawn (and counted). Fixed iteration order; pure given the PRNG state.
 */
export function bootstrapDifference(
  a: readonly CompRow[],
  b: readonly CompRow[],
  sessionCount: number,
  block: number,
  replicates: number,
  rng: Prng,
): DiffBootstrap {
  const S = sessionCount;
  if (!Number.isInteger(S) || S < 1)
    throw new RangeError("sessionCount must be a positive integer");
  if (!Number.isInteger(block) || block < 1)
    throw new RangeError("block must be a positive integer");
  if (!Number.isInteger(replicates) || replicates < 1)
    throw new RangeError("replicates must be a positive integer");
  if (a.length === 0 || b.length === 0) throw new RangeError("both sides need at least one row");
  checkSide(a, S);
  checkSide(b, S);
  const A = bySession(a, S);
  const Bs = bySession(b, S);
  const draws = Math.ceil(S / block);
  const out = new Float64Array(replicates);
  let redraws = 0;
  for (let r = 0; r < replicates; r += 1) {
    for (;;) {
      let sumA = 0;
      let nA = 0;
      let sumB = 0;
      let nB = 0;
      for (let dI = 0; dI < draws; dI += 1) {
        const start = belowInt(rng, S);
        for (let o = 0; o < block; o += 1) {
          const sess = (start + o) % S;
          for (let p = A.offsets[sess]!; p < A.offsets[sess + 1]!; p += 1) {
            sumA += A.values[p]!;
            nA += 1;
          }
          for (let p = Bs.offsets[sess]!; p < Bs.offsets[sess + 1]!; p += 1) {
            sumB += Bs.values[p]!;
            nB += 1;
          }
        }
      }
      if (nA > 0 && nB > 0) {
        out[r] = sumA / nA - sumB / nB;
        break;
      }
      redraws += 1;
    }
  }
  const estimate = mean(a.map((x) => x.value)) - mean(b.map((x) => x.value));
  return { estimate, se: sampleSd(out), replicates: out, redraws };
}

/**
 * Studentised p from replicate differences centred on the estimate. `sided` 2: P(|t*| >= |t|);
 * a direction (+1 / -1): one-sided P(dir * t* >= dir * t). The (1 + count) / (B + 1) form never
 * gives 0. A zero SE (all replicates equal) gives p = 1 when the estimate is 0, else 1 / (B + 1).
 */
export function studentisedDiffP(boot: DiffBootstrap, sided: 2 | Direction): number {
  const B = boot.replicates.length;
  if (boot.se === 0) return boot.estimate === 0 ? 1 : 1 / (B + 1);
  const t = boot.estimate / boot.se;
  let ge = 0;
  for (let i = 0; i < B; i += 1) {
    const tStar = (boot.replicates[i]! - boot.estimate) / boot.se;
    const hit = sided === 2 ? Math.abs(tStar) >= Math.abs(t) : sided * tStar >= sided * t;
    if (hit) ge += 1;
  }
  return (1 + ge) / (B + 1);
}

/** B = max(floor, ceil(factor / level)), with a relative 1e-9 guard (ARN-081; keys bootstrap_replications_*). */
export function replicatesFor(params: AgentParams, level: number): number {
  const s = params.stats;
  return Math.max(
    s.bootstrapReplicationsMin,
    Math.ceil(s.bootstrapReplicationsFactor / level - 1e-9),
  );
}

const sign = (x: number): Direction => (x < 0 ? -1 : 1);

function intervalOf(boot: DiffBootstrap, level: number): { lower: number; upper: number } {
  return {
    lower: percentile(boot.replicates, level / 2),
    upper: percentile(boot.replicates, 1 - level / 2),
  };
}

// ---- nightly descriptive ----

/** The two-sided interval level of the descriptive rows (ARN-062 "90 %"): the L1 bootstrap level. */
export const descriptiveLevel = (params: AgentParams): number =>
  params.learning.lessonBootstrapLevel;

/** One nightly row per pair, in pair-id order; deterministic. */
export function nightlyComparisons(
  params: AgentParams,
  pairs: readonly PairData[],
  d: string,
  masterSeed: bigint = STATS_MASTER_SEED,
): ComparisonRow[] {
  const minRows = params.learning.comparisonMinRows;
  const level = descriptiveLevel(params);
  const B = replicatesFor(params, level);
  return [...pairs].sort(byPair).map((p): ComparisonRow => {
    const nA = p.a.length;
    const nB = p.b.length;
    const base = { market: p.market, kind: "nightly" as const, pair_id: p.pairId, d };
    if (nA < minRows || nB < minRows) {
      return {
        ...base,
        n_a: nA,
        n_b: nB,
        estimate: null,
        lower: null,
        upper: null,
        p: null,
        bh_rank: null,
        discovery: 0,
        block: p.block,
        B: 0,
        label: labelNotEnoughData(Math.min(nA, nB)),
      };
    }
    const boot = bootstrapDifference(
      p.a,
      p.b,
      p.sessionCount,
      p.block,
      B,
      scopedPrng(`cmp:${p.market}:${p.pairId}:nightly:${d}`, masterSeed),
    );
    const iv = intervalOf(boot, level);
    return {
      ...base,
      n_a: nA,
      n_b: nB,
      estimate: boot.estimate,
      lower: iv.lower,
      upper: iv.upper,
      p: null,
      bh_rank: null,
      discovery: 0,
      block: p.block,
      B,
      label: LABEL_DESCRIPTIVE,
    };
  });
}

function byPair(x: { market: string; pairId: string }, y: { market: string; pairId: string }) {
  const kx = `${x.market}\u0000${x.pairId}`;
  const ky = `${y.market}\u0000${y.pairId}`;
  return kx < ky ? -1 : kx > ky ? 1 : 0;
}

// ---- Benjamini-Hochberg ----

export type BhEntry = { readonly id: string; readonly p: number };
export type BhResult = {
  readonly id: string;
  readonly p: number;
  /** 1-based rank in ascending p (ties by id). */
  readonly rank: number;
  readonly discovery: boolean;
};

/**
 * Benjamini-Hochberg step-up at level q over m tests: sort ascending by p (ties by id), find the
 * largest rank k with p_(k) <= k * q / m, and reject ranks 1..k (so a smaller p never loses to a larger
 * one). Returns results in rank order.
 */
export function benjaminiHochberg(entries: readonly BhEntry[], q: number): BhResult[] {
  const m = entries.length;
  const sorted = [...entries].sort((x, y) => (x.p !== y.p ? x.p - y.p : x.id < y.id ? -1 : 1));
  let k = 0;
  sorted.forEach((e, i) => {
    if (e.p <= ((i + 1) * q) / m) k = i + 1;
  });
  return sorted.map((e, i) => ({ id: e.id, p: e.p, rank: i + 1, discovery: i + 1 <= k }));
}

// ---- weekly test, candidates, look date ----

/** A candidate finding as stored (comparison_finding). */
export type FindingRow = {
  readonly id: string;
  readonly pair_id: string;
  readonly direction: Direction;
  readonly detected_d: string;
  readonly look_due_d: string;
  readonly state: "candidate" | "confirmed" | "discarded";
  readonly lockout_until_d: string | null;
  readonly look_result_ref: string | null;
};

export const findingId = (pairId: string, detectedD: string): string => `cf:${pairId}:${detectedD}`;

/** Sessions a look needs after detection: max(min_blocks * min block, min_blocks * block) (= max(75, 15 x block)). */
export function lookSessionsNeeded(params: AgentParams, block: number): number {
  const s = params.stats;
  return Math.max(s.minBlocks * s.bootstrapBlockMinSessions, s.minBlocks * block);
}

/** Session calendar owned by the caller: the date n trading sessions after d. */
export type AdvanceSessions = (d: string, n: number) => string;

/** Earliest possible look date: the session-count part of the look rule. The row-count part is `lookReady`. */
export function lookDueDate(
  params: AgentParams,
  detectedD: string,
  block: number,
  advance: AdvanceSessions,
): string {
  return advance(detectedD, lookSessionsNeeded(params, block));
}

/**
 * The look-date rule: the look runs on the first date its NEW data (rows entered after the detection
 * date) hold at least `comparison_min_rows` rows per side and at least max(75, 15 x block) sessions.
 */
export function lookReady(
  params: AgentParams,
  block: number,
  newRowsA: number,
  newRowsB: number,
  newSessions: number,
): boolean {
  const min = params.learning.comparisonMinRows;
  return newRowsA >= min && newRowsB >= min && newSessions >= lookSessionsNeeded(params, block);
}

/** Pairs the weekly test skips: an open candidate, or a lockout that has not ended (d <= lockout_until_d). */
export function excludedPairs(findings: readonly FindingRow[], d: string): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.state === "candidate") out.add(f.pair_id);
    else if (f.state === "discarded" && f.lockout_until_d !== null && d <= f.lockout_until_d)
      out.add(f.pair_id);
  }
  return out;
}

export type WeeklyOutcome = {
  readonly rows: ComparisonRow[];
  readonly candidates: FindingRow[];
};

/**
 * The weekly test on forward data up to Friday, run on Saturday `d`. Eligible pairs have at least
 * `comparison_min_rows` rows per side and are not excluded. B per test = max(1,000, ceil(20 m / q)) so
 * that the smallest BH threshold q / m is resolvable. Not-eligible pairs get a "not enough data" row
 * and are not counted in m. Deterministic.
 */
export function weeklyComparisons(
  params: AgentParams,
  pairs: readonly PairData[],
  d: string,
  existing: readonly FindingRow[],
  advance: AdvanceSessions,
  masterSeed: bigint = STATS_MASTER_SEED,
): WeeklyOutcome {
  const { comparisonMinRows: minRows, comparisonsFdrQ: q } = params.learning;
  const skip = excludedPairs(existing, d);
  const sorted = [...pairs].filter((p) => !skip.has(p.pairId)).sort(byPair);
  const eligible = sorted.filter((p) => p.a.length >= minRows && p.b.length >= minRows);
  const m = eligible.length;
  const B = m > 0 ? replicatesFor(params, q / m) : 0;
  const tests = eligible.map((p) => {
    const boot = bootstrapDifference(
      p.a,
      p.b,
      p.sessionCount,
      p.block,
      B,
      scopedPrng(`cmp:${p.market}:${p.pairId}:weekly:${d}`, masterSeed),
    );
    return { pair: p, boot, p: studentisedDiffP(boot, 2) };
  });
  const bh = new Map(
    benjaminiHochberg(
      tests.map((t) => ({ id: `${t.pair.market}\u0000${t.pair.pairId}`, p: t.p })),
      q,
    ).map((r) => [r.id, r]),
  );
  const level = descriptiveLevel(params);
  const rows: ComparisonRow[] = [];
  const candidates: FindingRow[] = [];
  for (const p of sorted) {
    const t = tests.find((x) => x.pair === p);
    const base = { market: p.market, kind: "weekly" as const, pair_id: p.pairId, d };
    if (!t) {
      rows.push({
        ...base,
        n_a: p.a.length,
        n_b: p.b.length,
        estimate: null,
        lower: null,
        upper: null,
        p: null,
        bh_rank: null,
        discovery: 0,
        block: p.block,
        B: 0,
        label: labelNotEnoughData(Math.min(p.a.length, p.b.length)),
      });
      continue;
    }
    const r = bh.get(`${p.market}\u0000${p.pairId}`)!;
    const iv = intervalOf(t.boot, level);
    rows.push({
      ...base,
      n_a: p.a.length,
      n_b: p.b.length,
      estimate: t.boot.estimate,
      lower: iv.lower,
      upper: iv.upper,
      p: t.p,
      bh_rank: r.rank,
      discovery: r.discovery ? 1 : 0,
      block: p.block,
      B,
      label: r.discovery ? LABEL_WEEKLY_DISCOVERY : LABEL_WEEKLY_NONE,
    });
    if (r.discovery) {
      candidates.push({
        id: findingId(p.pairId, d),
        pair_id: p.pairId,
        direction: sign(t.boot.estimate),
        detected_d: d,
        look_due_d: lookDueDate(params, d, p.block, advance),
        state: "candidate",
        lockout_until_d: null,
        look_result_ref: null,
      });
    }
  }
  return { rows, candidates };
}

// ---- the one confirmation look ----

export type LookOutcome = {
  readonly row: ComparisonRow;
  readonly passed: boolean;
  /** Set on a fail: the last locked-out date (lookD advanced by `comparison_lockout_sessions`). */
  readonly lockoutUntilD: string | null;
  readonly resultRef: string;
};

export const lookResultRef = (market: string, pairId: string, d: string): string =>
  `comparison_result:${market}:look:${pairId}:${d}`;

/**
 * Evaluate the single look of a candidate on the NEW data (rows entered after `finding.detected_d`;
 * session indices relative to that new window). One-sided at `comparison_look_alpha` in the detected
 * direction. The caller must check `lookReady` first; a not-ready look throws (it is never run early,
 * as the look is used once).
 */
export function evaluateLook(
  params: AgentParams,
  finding: FindingRow,
  pair: PairData,
  lookD: string,
  newSessions: number,
  advance: AdvanceSessions,
  masterSeed: bigint = STATS_MASTER_SEED,
): LookOutcome {
  if (finding.state !== "candidate") throw new Error("the look of this finding is already used");
  if (!lookReady(params, pair.block, pair.a.length, pair.b.length, newSessions))
    throw new Error("look not ready: new data below the look rule");
  const alpha = params.learning.comparisonLookAlpha;
  const B = replicatesFor(params, alpha);
  const boot = bootstrapDifference(
    pair.a,
    pair.b,
    pair.sessionCount,
    pair.block,
    B,
    scopedPrng(`look:${finding.id}`, masterSeed),
  );
  const p = studentisedDiffP(boot, finding.direction);
  const passed = p <= alpha && sign(boot.estimate) === finding.direction;
  const iv = intervalOf(boot, descriptiveLevel(params));
  return {
    row: {
      market: pair.market,
      kind: "look",
      pair_id: pair.pairId,
      d: lookD,
      n_a: pair.a.length,
      n_b: pair.b.length,
      estimate: boot.estimate,
      lower: iv.lower,
      upper: iv.upper,
      p,
      bh_rank: null,
      discovery: passed ? 1 : 0,
      block: pair.block,
      B,
      label: passed ? LABEL_LOOK_PASSED : LABEL_LOOK_FAILED,
    },
    passed,
    lockoutUntilD: passed ? null : advance(lookD, params.learning.comparisonLockoutSessions),
    resultRef: lookResultRef(pair.market, pair.pairId, lookD),
  };
}

// ---- persistence (idempotent) ----

const RESULT_COLS =
  "market, kind, pair_id, d, n_a, n_b, estimate, lower, upper, p, bh_rank, discovery, block, B, label";

const resultStmt = (r: ComparisonRow): InStatement => ({
  sql: `INSERT OR IGNORE INTO comparison_result (${RESULT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  args: [
    r.market,
    r.kind,
    r.pair_id,
    r.d,
    r.n_a,
    r.n_b,
    r.estimate,
    r.lower,
    r.upper,
    r.p,
    r.bh_rank,
    r.discovery,
    r.block,
    r.B,
    r.label,
  ],
});

const findingStmt = (f: FindingRow): InStatement => ({
  sql: `INSERT OR IGNORE INTO comparison_finding
        (id, pair_id, direction, detected_d, look_due_d, state, lockout_until_d, look_result_ref)
        VALUES (?,?,?,?,?,?,?,?)`,
  args: [
    f.id,
    f.pair_id,
    f.direction,
    f.detected_d,
    f.look_due_d,
    f.state,
    f.lockout_until_d,
    f.look_result_ref,
  ],
});

/** Insert result rows; a row whose key already exists is left untouched (re-runs are no-ops). */
export async function writeComparisonRows(
  db: Client,
  rows: readonly ComparisonRow[],
): Promise<void> {
  if (rows.length > 0) await db.batch(rows.map(resultStmt), "write");
}

/** Weekly outcome: result rows and candidate findings in one batch. */
export async function writeWeekly(db: Client, out: WeeklyOutcome): Promise<void> {
  const stmts = [...out.rows.map(resultStmt), ...out.candidates.map(findingStmt)];
  if (stmts.length > 0) await db.batch(stmts, "write");
}

/** Look outcome: the look row and the one-way finding transition, once (guarded by state = candidate). */
export async function writeLook(
  db: Client,
  findingIdValue: string,
  out: LookOutcome,
): Promise<void> {
  await db.batch(
    [
      resultStmt(out.row),
      {
        sql: `UPDATE comparison_finding SET state = ?, lockout_until_d = ?, look_result_ref = ?
              WHERE id = ? AND state = 'candidate'`,
        args: [
          out.passed ? "confirmed" : "discarded",
          out.lockoutUntilD,
          out.resultRef,
          findingIdValue,
        ],
      },
    ],
    "write",
  );
}

type Cell = string | number | null | bigint | ArrayBuffer;
const str = (v: Cell | undefined): string => String(v);

/** All stored findings, oldest first. */
export async function readFindings(db: Client): Promise<FindingRow[]> {
  const r = await db.execute(
    `SELECT id, pair_id, direction, detected_d, look_due_d, state, lockout_until_d, look_result_ref
     FROM comparison_finding ORDER BY detected_d, id`,
  );
  return r.rows.map((x) => ({
    id: str(x.id as Cell),
    pair_id: str(x.pair_id as Cell),
    direction: Number(x.direction) < 0 ? -1 : 1,
    detected_d: str(x.detected_d as Cell),
    look_due_d: str(x.look_due_d as Cell),
    state: str(x.state as Cell) as FindingRow["state"],
    lockout_until_d: x.lockout_until_d === null ? null : str(x.lockout_until_d as Cell),
    look_result_ref: x.look_result_ref === null ? null : str(x.look_result_ref as Cell),
  }));
}

// ---- reports (EML-037) ----

export type PairStatement = {
  readonly pairId: string;
  readonly n: number;
  /** The confirmed finding for the pair, with the numbers of its look, if any. */
  readonly confirmed?: {
    readonly direction: Direction;
    readonly estimate: number;
    readonly p: number;
  };
};

/**
 * Sections 4-5 wording per pair: a confirmed finding states its direction and numbers; otherwise
 * "no detectable difference (n = ...)" (EML-037).
 */
export function statementFor(s: PairStatement): string {
  if (!s.confirmed) return labelNoDetectableDifference(s.n);
  const c = s.confirmed;
  const word = c.direction > 0 ? "higher" : "lower";
  return `finding: ${s.pairId} ${word} (estimate ${c.estimate}, look p = ${c.p}, n = ${s.n})`;
}
