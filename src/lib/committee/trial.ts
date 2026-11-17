// Committee trial: the statistic, the verdict and the nightly step (M22 C2; VAL-111, ARN-105, BLD-051; D-1420, D-1421, D-1422).
//
// Statistic: D = mean outcome of the approved signals minus mean outcome of the rejected ones (outcomes: outcomes.ts).
// Null: label permutations WITHIN each night (the night's approve / neutral / reject labels are shuffled among that night's
// signals, outcomes fixed), `committee_permutations` of them, seeded by `scopedPrng("committee:<trial id>")`; when the
// number of distinct labelings is not larger than that count every labeling is counted instead (exact p). One-sided p =
// the share of labelings (the observed one included) whose D is at least the observed D, compared in exact integers.
// Verdict (D-1421): PASS needs the sessions and the settled sample of the pre-registration, p below 0.05, D above one round
// trip, and no negative D on any judge-model segment of at least 50 settled signals; FAIL when the sample and sessions are
// met and the test is not; INCONCLUSIVE after twice the sessions without the sample. Each night writes an `interim` row
// ("interim, not a result"); the `final` row is written once together with its `holdout_look` row (lineage
// `committee_trial`) and then the night switches the Committee off through the audited config path (actor system).
// A later pre-registration version marks the trial INVALID with an alert (no look is taken: nothing was measured).
// Writes only the result rows, the look row, an alert line and the one config row; nothing here reaches trading (PRD-033).
import type { Client } from "@libsql/client";
import { getConfig, setConfig } from "@/lib/config/store";
import { belowInt, scopedPrng } from "@/lib/stats/rng";
import { parseFrozen, preregProblem, readVersions, TRIAL_LINEAGE, type Frozen } from "./prereg";
import { readOutcomes, type RatedOutcome } from "./outcomes";
import { readTrial } from "./store";

export type Verdict = "running" | "PASS" | "FAIL" | "INCONCLUSIVE" | "INVALID";
export type Label = "approve" | "neutral" | "reject";

/** The words of a stored reason (the page and the health line turn these into plain text). */
export type Reason =
  | "sessions_short"
  | "sample_short"
  | "sample_never_met"
  | "passed"
  | "not_significant"
  | "below_cost"
  | "reversal"
  | "no_contrast"
  | "edited"
  | "unreadable";

export const INTERIM_NOTE = "interim, not a result";
const STATS_MAX = 3900; // threshold-ok: committee_trial_result.stats_json CHECK is 4000 characters
const SEGMENT_ROWS = 8; // threshold-ok: at most eight judge-model segments are stored
const SCALE_D = 10; // threshold-ok: D stored to a tenth of a ppm
const SCALE_P = 1_000_000; // threshold-ok: p stored to six places
const PPM = 1_000_000; // threshold-ok: parts per million

// ---------------------------------------------------------------------------------------------------------------------
// Statistic
// ---------------------------------------------------------------------------------------------------------------------

export type LabelledRow = Pick<RatedOutcome, "d" | "signalId" | "rating" | "netPpm" | "judgeModel">;

/** Mean approve outcome minus mean reject outcome (ppm); null when either side is empty. */
export function diffOf(rows: readonly Pick<LabelledRow, "rating" | "netPpm">[]): number | null {
  let sa = 0;
  let na = 0;
  let sr = 0;
  let nr = 0;
  for (const r of rows) {
    if (r.rating === "approve") {
      sa += r.netPpm;
      na += 1;
    } else if (r.rating === "reject") {
      sr += r.netPpm;
      nr += 1;
    }
  }
  return na === 0 || nr === 0 ? null : sa / na - sr / nr;
}

export type PermTest = {
  /** The observed D (ppm), null without both an approved and a rejected signal. */
  d: number | null;
  /** One-sided p, null when D is null. */
  p: number | null;
  /** The permutations asked for (the key), and how many labelings were counted. */
  permutations: number;
  counted: number;
  exact: boolean;
  approve: number;
  neutral: number;
  reject: number;
};

const LABELS: readonly Label[] = ["approve", "neutral", "reject"];

type Night = { labels: Label[]; outcomes: number[] };

function nightsOf(rows: readonly LabelledRow[]): Night[] {
  const sorted = [...rows].sort((a, b) =>
    a.d < b.d ? -1 : a.d > b.d ? 1 : a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0,
  );
  const out: Night[] = [];
  let last: string | null = null;
  for (const r of sorted) {
    if (r.d !== last) {
      out.push({ labels: [], outcomes: [] });
      last = r.d;
    }
    const n = out[out.length - 1]!;
    n.labels.push(r.rating);
    n.outcomes.push(r.netPpm);
  }
  return out;
}

/** The distinct orderings of a night's label multiset, as contribution values T_i = Sa*nR - Sr*nA (exact integers). */
function distinctContributions(n: Night, nA: number, nR: number): number[] {
  const counts = new Map<Label, number>(
    LABELS.map((l) => [l, n.labels.filter((x) => x === l).length]),
  );
  const out: number[] = [];
  const size = n.labels.length;
  const place = (i: number, sa: number, sr: number): void => {
    if (i === size) {
      out.push(sa * nR - sr * nA);
      return;
    }
    for (const l of LABELS) {
      const c = counts.get(l)!;
      if (c === 0) continue;
      counts.set(l, c - 1);
      place(
        i + 1,
        l === "approve" ? sa + n.outcomes[i]! : sa,
        l === "reject" ? sr + n.outcomes[i]! : sr,
      );
      counts.set(l, c);
    }
  };
  place(0, 0, 0);
  return out;
}

const contribution = (
  labels: readonly Label[],
  outcomes: readonly number[],
  nA: number,
  nR: number,
): number => {
  let sa = 0;
  let sr = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === "approve") sa += outcomes[i]!;
    else if (labels[i] === "reject") sr += outcomes[i]!;
  }
  return sa * nR - sr * nA;
};

/** Number of distinct orderings of the night's labels, capped just above `cap` (returns cap + 1 when larger). */
function orderings(n: Night, cap: number): number {
  const size = n.labels.length;
  let total = 1;
  let rest = size;
  for (const l of LABELS) {
    const c = n.labels.filter((x) => x === l).length;
    // multiply by C(rest, c), computed exactly and early-out above the cap
    let comb = 1;
    for (let k = 1; k <= c; k++) comb = (comb * (rest - c + k)) / k;
    total *= comb;
    rest -= c;
    if (total > cap) return cap + 1;
  }
  return total;
}

/**
 * The within-night permutation test of D (D-1421). `scope` seeds the draws (`committee:<trial id>`): the same table and
 * scope always give the same p. With at most `permutations` distinct labelings in all, every one is counted (exact).
 */
export function permutationTest(
  rows: readonly LabelledRow[],
  permutations: number,
  scope: string,
): PermTest {
  const nights = nightsOf(rows);
  let nA = 0;
  let nN = 0;
  let nR = 0;
  for (const r of rows) {
    if (r.rating === "approve") nA += 1;
    else if (r.rating === "neutral") nN += 1;
    else nR += 1;
  }
  const base = { permutations, approve: nA, neutral: nN, reject: nR };
  if (nA === 0 || nR === 0) return { ...base, d: null, p: null, counted: 0, exact: false };
  const obs = nights.reduce((s, n) => s + contribution(n.labels, n.outcomes, nA, nR), 0);
  const d = obs / (nA * nR);
  let space = 1;
  for (const n of nights) {
    space *= orderings(n, permutations);
    if (space > permutations) break;
  }
  if (space <= permutations) {
    // exact: every combination of the nights' distinct orderings
    const lists = nights.map((n) => distinctContributions(n, nA, nR));
    let atLeast = 0;
    let total = 0;
    const walk = (i: number, sum: number): void => {
      if (i === lists.length) {
        total += 1;
        if (sum >= obs) atLeast += 1;
        return;
      }
      for (const c of lists[i]!) walk(i + 1, sum + c);
    };
    walk(0, 0);
    return { ...base, d, p: atLeast / total, counted: total, exact: true };
  }
  const rng = scopedPrng(scope);
  const work = nights.map((n) => ({ labels: [...n.labels], outcomes: n.outcomes }));
  let atLeast = 0;
  for (let i = 0; i < permutations; i++) {
    let sum = 0;
    for (const n of work) {
      for (let j = n.labels.length - 1; j > 0; j--) {
        const k = belowInt(rng, j + 1);
        const t = n.labels[j]!;
        n.labels[j] = n.labels[k]!;
        n.labels[k] = t;
      }
      sum += contribution(n.labels, n.outcomes, nA, nR);
    }
    if (sum >= obs) atLeast += 1;
  }
  // the observed labeling is one of the labelings: (1 + count) / (1 + P)
  return { ...base, d, p: (1 + atLeast) / (1 + permutations), counted: permutations, exact: false };
}

export type Segment = { model: string; n: number; d: number | null };

/** D per judge model (settled signals only), models in name order; a signal with no judge model is `none`. */
export function segmentsOf(rows: readonly LabelledRow[]): Segment[] {
  const by = new Map<string, LabelledRow[]>();
  for (const r of rows) {
    const k = r.judgeModel ?? "none";
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.keys()].sort().map((model) => {
    const g = by.get(model)!;
    return { model, n: g.length, d: diffOf(g) };
  });
}

export type Measure = {
  nights: number;
  ratedNights: number;
  settled: number;
  unsettled: number;
  lateExit: number;
  test: PermTest;
  segments: Segment[];
};

/** The verdict from the measurement and the pre-registration (D-1421). Pure. */
export function verdictOf(
  f: Frozen,
  m: Measure,
): { verdict: Verdict; reason: Reason; reversal: boolean } {
  const sampleMet = m.settled >= f.min_settled;
  const sessionsMet = m.nights >= f.trial_sessions;
  const reversal =
    m.test.d !== null &&
    m.test.d > 0 &&
    m.segments.some((s) => s.n >= f.segment_min && s.d !== null && s.d < 0);
  if (!sampleMet) {
    return m.nights >= 2 * f.trial_sessions
      ? { verdict: "INCONCLUSIVE", reason: "sample_never_met", reversal }
      : { verdict: "running", reason: "sample_short", reversal };
  }
  if (!sessionsMet) return { verdict: "running", reason: "sessions_short", reversal };
  if (m.test.d === null || m.test.p === null)
    return { verdict: "FAIL", reason: "no_contrast", reversal };
  if (!(m.test.p < f.p_level_ppm / PPM))
    return { verdict: "FAIL", reason: "not_significant", reversal };
  if (!(m.test.d > f.cost_threshold_ppm))
    return { verdict: "FAIL", reason: "below_cost", reversal };
  if (reversal) return { verdict: "FAIL", reason: "reversal", reversal };
  return { verdict: "PASS", reason: "passed", reversal };
}

const round = (x: number, scale: number): number => Math.round(x * scale) / scale;

/** The stored statistics (at most 4,000 characters, the table's CHECK). */
export function statsJson(
  m: Measure,
  v: { reason: Reason; reversal: boolean },
  f: Frozen | null,
  interim: boolean,
): string {
  const body: Record<string, unknown> = {
    ...(interim ? { note: INTERIM_NOTE } : {}),
    reason: v.reason,
    nights: m.nights,
    rated_nights: m.ratedNights,
    settled: m.settled,
    unsettled: m.unsettled,
    late_exit: m.lateExit,
    approve: m.test.approve,
    neutral: m.test.neutral,
    reject: m.test.reject,
    d_ppm: m.test.d === null ? null : round(m.test.d, SCALE_D),
    p: m.test.p === null ? null : round(m.test.p, SCALE_P),
    permutations: m.test.permutations,
    counted: m.test.counted,
    exact: m.test.exact,
    cost_threshold_ppm: f?.cost_threshold_ppm ?? null,
    reversal: v.reversal,
    segments: m.segments.slice(0, SEGMENT_ROWS).map((s) => ({
      model: s.model.slice(0, 64),
      n: s.n,
      d_ppm: s.d === null ? null : round(s.d, SCALE_D),
    })), // threshold-ok: model name cut
  };
  const text = JSON.stringify(body);
  return text.length <= STATS_MAX ? text : JSON.stringify({ ...body, segments: [] });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------------------------------------------------

export type StepOptions = {
  market: string;
  d: string;
  today: string;
  replay?: boolean;
  /** ISO UTC time stamped on every row written. */
  now: string;
  /** The switch as the caller already knows it; default: read `committee_enabled` (tests and the complement proof pass it). */
  switchOn?: boolean;
};

export type StepResult =
  | { status: "refused" | "off" | "no_trial" | "finished" }
  | { status: "running"; trialId: string; reason: Reason }
  | { status: "final"; trialId: string; verdict: Exclude<Verdict, "running"> };

async function counts(
  db: Client,
  market: string,
  trialId: string,
): Promise<{ nights: number; ratedNights: number }> {
  // rows-ok: committee_rating index (trial_id, d), at most 252 sessions x 5 signals, aggregate over the trial
  const r = await db.execute({
    sql: `SELECT COUNT(DISTINCT d) AS nights,
                 COUNT(DISTINCT CASE WHEN rating IN ('approve', 'neutral', 'reject') THEN d END) AS rated
            FROM committee_rating WHERE trial_id = ? AND market = ?`,
    args: [trialId, market],
  });
  return { nights: Number(r.rows[0]?.nights ?? 0), ratedNights: Number(r.rows[0]?.rated ?? 0) };
}

/** Measures a trial from the stored rows (nothing is written). */
export async function measureTrial(
  db: Client,
  o: { market: string; trialId: string; frozen: Frozen },
): Promise<Measure> {
  const c = await counts(db, o.market, o.trialId);
  const out = await readOutcomes(db, {
    market: o.market,
    trialId: o.trialId,
    horizonSessions: o.frozen.horizon_sessions,
  });
  return {
    nights: c.nights,
    ratedNights: c.ratedNights,
    settled: out.settled.length,
    unsettled: out.unsettled,
    lateExit: out.lateExit,
    test: permutationTest(out.settled, o.frozen.permutations, `committee:${o.trialId}`),
    segments: segmentsOf(out.settled),
  };
}

async function alertLine(db: Client, now: string, message: string): Promise<void> {
  // rows-ok: one alert line for the Owner when a trial ends invalid
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
    args: [now, "committee-trial", message.slice(0, 500)], // threshold-ok: log length
  });
}

async function switchOff(db: Client, now: string, reason: string): Promise<void> {
  if ((await getConfig(db, "committee_enabled")) !== "on") return;
  try {
    await setConfig(db, {
      key: "committee_enabled",
      value: "off",
      userId: null, // the system, not a person (D-1421)
      reason: reason.slice(0, 200), // threshold-ok: the audit reason is at most 200 characters
      now,
    });
  } catch {
    // the next night's step finds the final row, sees the switch still on and writes it again
  }
}

async function writeFinal(
  db: Client,
  o: StepOptions,
  trialId: string,
  verdict: Exclude<Verdict, "running">,
  stats: string,
  sha: string,
): Promise<boolean> {
  // rows-ok: one keyed insert, once per trial (the primary key makes the final verdict a one-time write)
  const w = await db.execute({
    sql: `INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at)
          VALUES (?, ?, ?, 'final', ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [trialId, o.market, o.d, verdict, stats, o.now],
  });
  if (w.rowsAffected === 0) return false;
  if (verdict !== "INVALID") await writeLook(db, o, verdict, sha);
  return true;
}

async function writeLook(
  db: Client,
  o: Pick<StepOptions, "market" | "now">,
  verdict: string,
  sha: string,
): Promise<void> {
  // rows-ok: one keyed insert into the look registry (lineage, market); never repeated
  await db.execute({
    sql: `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [TRIAL_LINEAGE, o.market, o.now, sha, verdict],
  });
}

const VERDICT_WORD: Record<string, string> = {
  PASS: "passed",
  FAIL: "failed",
  INCONCLUSIVE: "was inconclusive",
  INVALID: "is invalid",
};

/**
 * One night of the trial, after the Committee night (D-1420, D-1421). Forward only. Does nothing when no pre-registration
 * exists or the switch is off. A finished trial is never measured again: the step only makes sure the switch is off and the
 * look is on file. Otherwise it writes the night's `interim` row, or the `final` row (with the look) when the verdict is in.
 */
export async function trialNight(db: Client, o: StepOptions): Promise<StepResult> {
  if (o.replay === true || o.d !== o.today) return { status: "refused" };
  const trial = await readTrial(db, o.market);
  if (trial === null) return { status: "no_trial" };
  const versions = await readVersions(db, o.market, trial.trialId);
  if (trial.finished) {
    await switchOff(db, o.now, "The Committee trial has ended");
    const first = versions[0];
    // repair: a final verdict other than INVALID always has its look on file
    // rows-ok: committee_trial_result primary key (trial_id, market, d, kind) prefix, LIMIT 1
    const fin = await db.execute({
      sql: `SELECT verdict FROM committee_trial_result WHERE trial_id = ? AND market = ? AND kind = 'final' LIMIT 1`,
      args: [trial.trialId, o.market],
    });
    const v = fin.rows[0] === undefined ? null : String(fin.rows[0].verdict);
    if (first !== undefined && v !== null && v !== "INVALID") await writeLook(db, o, v, first.sha);
    return { status: "finished" };
  }
  if (!(o.switchOn ?? (await getConfig(db, "committee_enabled")) === "on"))
    return { status: "off" };
  const problem = preregProblem(versions);
  const first = versions[0];
  if (problem !== null || first === undefined) {
    const reason: Reason = versions.length > 1 ? "edited" : "unreadable";
    const text = JSON.stringify({
      reason,
      detail: problem ?? "no pre-registration",
      versions: versions.length,
    });
    const wrote = await writeFinal(
      db,
      o,
      trial.trialId,
      "INVALID",
      text,
      first?.sha ?? "0".repeat(64),
    ); // threshold-ok: sha length
    if (wrote) {
      await alertLine(
        db,
        o.now,
        `The Committee trial ${VERDICT_WORD.INVALID}: ${problem ?? "no pre-registration"}. The Committee has been switched off.`,
      );
    }
    await switchOff(db, o.now, "The Committee trial is invalid");
    return { status: "final", trialId: trial.trialId, verdict: "INVALID" };
  }
  const frozen = parseFrozen(first.frozenJson)!;
  const m = await measureTrial(db, { market: o.market, trialId: trial.trialId, frozen });
  const v = verdictOf(frozen, m);
  if (v.verdict === "running") {
    // rows-ok: one keyed insert per night (trial_id, market, d, kind); a repeat the same day keeps the first
    await db.execute({
      sql: `INSERT INTO committee_trial_result (trial_id, market, d, kind, verdict, stats_json, created_at)
            VALUES (?, ?, ?, 'interim', 'running', ?, ?) ON CONFLICT DO NOTHING`,
      args: [trial.trialId, o.market, o.d, statsJson(m, v, frozen, true), o.now],
    });
    return { status: "running", trialId: trial.trialId, reason: v.reason };
  }
  const wrote = await writeFinal(
    db,
    o,
    trial.trialId,
    v.verdict,
    statsJson(m, v, frozen, false),
    first.sha,
  );
  await switchOff(db, o.now, `The Committee trial ${VERDICT_WORD[v.verdict]}`);
  if (wrote)
    await alertLine(
      db,
      o.now,
      `The Committee trial ${VERDICT_WORD[v.verdict]}. The Committee has been switched off.`,
    );
  return { status: "final", trialId: trial.trialId, verdict: v.verdict };
}
