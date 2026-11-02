// AT-43 "Sizing and cost gates": the synthetic night (M14; docs/M14_design.md section 5). Everything is
// synthetic (ZZ codes, invented numbers, no market data: SEC-110). One night, about twelve candidates:
//
//   stop distance   ZZS08 (about 8 %) and ZZS15 (about 15 %) are real F4 candidates out of runFamilies;
//                   ZZS12 (exactly 12 %), ZZS12X (12.0001 %) and ZZF5 (an F5 whose 15 % stop sits under
//                   its own 20 % cap) are exact StopSpecs, so the boundary is tested to the micro.
//   ADV buckets     ZZB1 (>= A$5M), ZZB2 (A$1-5M), ZZB3 (A$250k-1M), ZZB4 (< A$250k); one candidate each,
//                   with an injected cost-gate table (F4 median gross 3 %, F1 5 %, F2 only 20 rows).
//   second position ZZA1 and ZZA2 (same industry), ZZM (other industry, correlation 0.8 with ZZA1),
//                   ZZE (other industry, correlation 0.4 with ZZA1).
//   SHOCK           a half-size candidate for the FAM-009 case.
//
// Plus the database night (`buildAt43Night`) that batch 2b and the cohort replay both read.
import { runFamilies } from "@/lib/agents/families";
import { stopDistance } from "@/lib/agents/families/stopCap";
import type { Candidate, CodeFacts, StopSpec } from "@/lib/agents/families/types";
import { costGateTable, type CostGateRow, type CostGateTable } from "@/lib/agents/costGate";
import { defaultAgentParams, type AgentParams } from "@/lib/agents/params";
import type { Client } from "@libsql/client";
import type { Family } from "@/lib/agents/schema";
import { makeRational, type Rational } from "@/lib/money/rational";
import { lineageId } from "@/lib/stats/splits";
import {
  CENT,
  D,
  DOLLAR,
  factsOf,
  inputsOf,
  makeBars,
  sessionList,
  override,
  wobble,
} from "../agents/families/builders";
import { buildWorld, type WorldCode } from "../replay/ledgerWorld";

export const P: AgentParams = defaultAgentParams();

// ------------------------------------------------------------------------------------------------
// FAM-004: stop distances
// ------------------------------------------------------------------------------------------------

/** An oversold series: rising to session 296, then 4 % down a day (an F4 entry on the last session). */
const oversold = (i: number): bigint => {
  const base = DOLLAR + BigInt(Math.min(i, 296)) * CENT;
  const k = BigInt(Math.max(0, i - 296));
  return (base * (100n - 4n * k)) / 100n;
};

/** Daily half range in micro that gives an F4 two-ATR stop of about the wanted distance (calibrated). */
export const SPREAD_FOR_8_PCT = 54_100n;
export const SPREAD_FOR_15_PCT = 114_600n;

export function oversoldFacts(code: string, spread: bigint): CodeFacts {
  return factsOf(code, "U1", makeBars({ close: oversold, spread }), P);
}

/** The F4 candidate of a code under a cap of 99 % (so the test sees every stop before the 12 % cap). */
export function f4Candidate(facts: CodeFacts): Candidate {
  const open = { ...P, entry: { ...P.entry, maxStopDistance: makeRational(99n, 100n) } };
  const c = runFamilies(inputsOf([facts]), open).candidates.find((x) => x.family === "F4");
  if (c === undefined) throw new Error(`no F4 candidate for ${facts.code}`);
  return c;
}

const capSpec = (num: bigint, den: bigint): StopSpec => ({
  atr_micro: null,
  k: null,
  cap: makeRational(num, den),
  level_micro: null,
});

export type StopCase = {
  readonly code: string;
  readonly cand: Candidate;
  readonly refMicro: bigint;
  /** Approximate distance as designed; `exact` cases are exact fractions. */
  readonly label: string;
  readonly exact: Rational | null;
  readonly overCap: boolean;
};

/** ZZS12, ZZS12X and ZZF5 on a A$10.00 reference with exact stops. */
export function exactStopCases(template: Candidate): StopCase[] {
  const ref = 10n * DOLLAR;
  const make = (
    code: string,
    family: Candidate["family"],
    spec: StopSpec,
    label: string,
    overCap: boolean,
  ): StopCase => ({
    code,
    cand: { ...template, code, family, stopSpec: spec },
    refMicro: ref,
    label,
    exact: null,
    overCap,
  });
  return [
    make("ZZS12", "F4", capSpec(12n, 100n), "exactly 12 %", false),
    make("ZZS12X", "F4", capSpec(120_001n, 1_000_000n), "12.0001 %", true),
    // F5: stop = max(ATR part, 20 % cap part); an ATR part of A$1.50 gives 15 %, under F5's own cap
    make(
      "ZZF5",
      "F5",
      { atr_micro: 750_000n, k: makeRational(2n), cap: makeRational(20n, 100n), level_micro: null },
      "F5, 15 % under its 20 % cap",
      true,
    ),
  ];
}

export const distanceOf = (c: Pick<StopCase, "cand" | "refMicro">): number => {
  const r = stopDistance(c.cand, c.refMicro);
  return Number(r.num) / Number(r.den);
};

// ------------------------------------------------------------------------------------------------
// FAM-005 / FAM-006 / FAM-009: gated candidates
// ------------------------------------------------------------------------------------------------

/**
 * A series whose daily simple return is s * (a * alt_j + b * quad_j) with alt = +1,-1,... and
 * quad = +1,+1,-1,-1,...; the two patterns are orthogonal over a multiple of four sessions, so the
 * 60-session return correlation of (a1, b1) with (a2, b2) is (a1 a2 + b1 b2) / norms.
 */
export function patternCloses(a: number, b: number, n = 300): bigint[] {
  const s = 0.01;
  const out: bigint[] = [];
  let level = 10 * Number(DOLLAR);
  for (let j = 0; j < n; j += 1) {
    const alt = j % 2 === 0 ? 1 : -1;
    const quad = j % 4 < 2 ? 1 : -1;
    level *= 1 + s * (a * alt + b * quad);
    out.push(BigInt(Math.round(level)));
  }
  return out;
}

/** Facts with a pattern price series, a share volume (sets the ADV bucket) and an industry. */
export function patternFacts(
  code: string,
  industry: string | null,
  a: number,
  b: number,
  volume: bigint,
): CodeFacts {
  const closes = patternCloses(a, b);
  return override(
    factsOf(code, "U1", makeBars({ close: (i) => closes[i]!, volume: () => volume }), P),
    { industry },
  );
}

/** Share volumes for the four ADV buckets at a price near A$10: about A$7M, A$3M, A$500k and A$100k. */
export const BUCKET_VOLUMES = [700_000n, 300_000n, 50_000n, 10_000n] as const;
export const BUCKET_LABELS = ["ADV >= A$5M", "A$1-5M", "A$250k-1M", "< A$250k"] as const;

/** Table rows of one (family, rule version, variant): `n` closed development rows of gross num/den. */
export function grossRows(
  family: Candidate["family"],
  n: number,
  num: bigint,
  den = 100n,
): CostGateRow[] {
  return Array.from({ length: n }, () => ({
    family,
    ruleVersion: `${family}.v1`,
    variant: family,
    grossNum: num,
    grossDen: den,
  }));
}

/** The injected table: F4 median gross 3 %, F1 5 %, F2 only 20 rows (unmeasured). */
export function injectedCostTable(): CostGateTable {
  return costGateTable([
    ...grossRows("F4", 40, 3n),
    ...grossRows("F1", 40, 5n),
    ...grossRows("F2", 20, 9n),
  ]);
}

/** A candidate of any family on top of a real F4 one (rank, plan and stop are not read by the gates). */
export function asFamily(
  template: Candidate,
  code: string,
  family: Candidate["family"],
  over: Partial<Candidate> = {},
): Candidate {
  return { ...template, code, family, ruleVersion: `${family}.v1`, variant: family, ...over };
}


// ------------------------------------------------------------------------------------------------
// Clause 3: lineages with a development window over the whole ledger world
// ------------------------------------------------------------------------------------------------

/**
 * Inserts the lineage `AU:<family>` and a stored split whose development window is the whole ledger
 * world (every entry is a development row); the validation and holdout windows lie after the data, so
 * the robustness stage (which never reads them) sees nothing else.
 */
export async function addDevelopmentLineage(
  db: Client,
  family: Family,
  lastSession: string,
): Promise<void> {
  const id = lineageId("AU", family);
  await db.execute({
    sql: "INSERT INTO lineage (id, created_d, parent) VALUES (?, ?, NULL)",
    args: [id, "2026-01-01"],
  });
  await db.execute({
    sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
            purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
            dev_end_d, deferred_until_d, reason, measured_on_run)
          VALUES (?, 1, 10, 60, 60, 20, ?, ?, ?, ?, ?, ?, NULL, 'create', NULL)`,
    args: [
      id,
      lastSession,
      "2027-05-03",
      "2027-07-23",
      "2027-02-01",
      "2027-04-23",
      lastSession,
    ],
  });
}
/**
 * The ledger world of tests/learning/robustness.test.ts (ZZA leads 40 quiet peers, breaks out on a
 * volume spike at session 281, dips at 283 and recovers), run over 450 sessions instead of 300 so the
 * time-stop-only comparator (it keeps only the 120-session max hold) also closes inside the data.
 * Built from fixtures/replay/ledgerWorld.ts (its `sessions` option).
 */
export const ROBUSTNESS_SESSIONS = sessionList(D, 450);
export const ROBUSTNESS_FROM = 270;

export function robustnessWorld() {
  const n = ROBUSTNESS_SESSIONS.length;
  const spikes = new Set([280, 282, 285, 288, 295]);
  const leaderClose = (i: number): bigint => {
    let c = DOLLAR + BigInt(i) * CENT;
    if (i >= 283) c -= 20n * CENT;
    if (i >= 285) c += 70n * CENT;
    return c;
  };
  const leader: WorldCode = {
    code: "ZZA",
    tier: "U1",
    bars: makeBars({
      n,
      close: leaderClose,
      volume: (i) => (spikes.has(i) ? 2_000_000n : 1_000_000n),
    }),
  };
  const peers: WorldCode[] = Array.from({ length: 40 }, (_, i) => ({
    code: `ZZP${String(i).padStart(2, "0")}`,
    tier: "U1" as const,
    bars: makeBars({ n, close: wobble(2n * DOLLAR + BigInt(i) * 3n * CENT) }),
  }));
  return buildWorld([leader, ...peers], P, { sessions: ROBUSTNESS_SESSIONS });
}

// ------------------------------------------------------------------------------------------------
// Clause 2: the database night (batch 2b live, cohort replay) -- decision night = session AT43_NIGHT
// ------------------------------------------------------------------------------------------------

/** The decision night: session index 300 of the batch 2b harness calendar (330 weekdays from 2030-01-02). */
export const AT43_NIGHT = 300;

export type NightSpec = {
  readonly code: string;
  readonly industry: string;
  /** Weights of the alternating and the +,+,-,- return patterns (see `patternCloses`). */
  readonly a: number;
  readonly b: number;
  /** Fall on the decision night, in percent (an F4 entry). */
  readonly dipPct: number;
  /** Shares traded a day (sets the ADV bucket at a price near A$10). */
  readonly volume: bigint;
  /** Daily return scale of the patterns (default 1.2 %). */
  readonly scale?: number;
  /** Daily drift (default 0.15 %). */
  readonly drift?: number;
  /** Start price in dollars (default 10); a high one makes a one-share parcel unaffordable. */
  readonly startPrice?: number;
};

/**
 * Close (micro) per session: a 0.15 % daily drift plus s * (a * alt + b * quad), a dip of `dipPct` on the
 * decision night, then the same process on. Deterministic; no random source.
 */
export function nightCloses(spec: NightSpec, sessions = 330): bigint[] {
  const s = spec.scale ?? 0.012;
  const out: bigint[] = [];
  let level = (spec.startPrice ?? 10) * Number(DOLLAR);
  for (let j = 0; j < sessions; j += 1) {
    const alt = j % 2 === 0 ? 1 : -1;
    const quad = j % 4 < 2 ? 1 : -1;
    const r = j === AT43_NIGHT ? -spec.dipPct / 100 : (spec.drift ?? 0.0015) + s * (spec.a * alt + spec.b * quad);
    level *= 1 + r;
    out.push(BigInt(Math.round(level)));
  }
  return out;
}

/**
 * The night's codes. Roles (the F4 rank order is A1 > A2 > M > E > X > Z, set by the dips):
 *   ZZQ1 Banks, first leg (ADV about A$10M)
 *   ZZQ2 Banks, same industry as ZZQ1 -> second_position
 *   ZZQ3 Materials, return correlation about 0.8 with ZZQ1 -> second_position
 *   ZZQ4 Energy, correlation about 0.4 with ZZQ1, ADV about A$4.5M -> the second leg
 *   ZZQ5 Utilities, ADV about A$150k (the < A$250k bucket) -> skipped_cost_gate (F4 median 5 % < 2 x 4.07 %)
 *   ZZQ6 Telco, a 13 % two-ATR stop -> skipped_stop_distance (blocked inside runFamilies)
 */
export const NIGHT_SPECS: readonly NightSpec[] = [
  { code: "ZZQ1", industry: "Banks", a: 1, b: 0, dipPct: 12, volume: 700_000n },
  { code: "ZZQ2", industry: "Banks", a: 0, b: 1, dipPct: 6, volume: 700_000n },
  { code: "ZZQ3", industry: "Materials", a: 0.8, b: 0.6, dipPct: 4, volume: 700_000n },
  { code: "ZZQ4", industry: "Energy", a: 0.25, b: Math.sqrt(1 - 0.0625), dipPct: 3, volume: 300_000n },
  { code: "ZZQ5", industry: "Utilities", a: 0, b: 1, dipPct: 3, volume: 10_000n },
  {
    code: "ZZQ6",
    industry: "Telco",
    a: 0,
    b: 1,
    dipPct: 12,
    volume: 5_000n,
    scale: 0.07,
    drift: 0.02,
  },
];

/** The injected FAM-005 table of the night: F4 median gross return 5 % over 40 development rows. */
export const nightCostTable = (): CostGateTable => costGateTable(grossRows("F4", 40, 5n));

/** Cohort seed: A$3,000 (two parcels fit), or A$900 (below two parcels) for the SHOCK scenario. */
export const SEED_TWO_LEGS = 3_000_000_000n;
export const SEED_BELOW_TWO_PARCELS = 900_000_000n;

export type NightScenario = {
  /** A code halted (universe flag, no bar) from this session index on. */
  readonly halt?: { readonly code: string; readonly from: number };
  /** The index falls 2 % a day over the five sessions up to the decision night: regime SHOCK. */
  readonly shock?: boolean;
  /** A delisting with this ex-session index (a disposal across the next session) on `code`. */
  readonly delisting?: { readonly code: string; readonly exIndex: number };
  /** Codes whose price level is set so high that sizing rejects them at the parcel (FAM-006 retry). */
  readonly expensive?: readonly string[];
};

/** Rows of the harness databases that this night adds on top of `buildNight` (industry, halt, shock). */
export async function applyNightScenario(
  db: Client,
  dates: readonly string[],
  scn: NightScenario,
): Promise<void> {
  for (const s of NIGHT_SPECS) {
    await db.execute({
      sql: "INSERT INTO instrument (market, code, name, industry) VALUES ('AU', ?, ?, ?)",
      args: [s.code, s.code, s.industry],
    });
  }
  if (scn.halt !== undefined) {
    // price_bar and universe_snapshot are append-only: lift the guards of this scratch database
    await db.execute("DROP TRIGGER IF EXISTS price_bar_prune_only");
    await db.execute("DROP TRIGGER IF EXISTS universe_snapshot_no_update");
    await db.execute({
      sql: "DELETE FROM price_bar WHERE code = ? AND d >= ?",
      args: [scn.halt.code, dates[scn.halt.from]!],
    });
    await db.execute({
      sql: "UPDATE universe_snapshot SET halted = 1 WHERE code = ? AND d >= ?",
      args: [scn.halt.code, dates[scn.halt.from]!],
    });
  }
  if (scn.shock === true) {
    await db.execute("DROP TRIGGER IF EXISTS index_bar_no_update");
    for (let k = 1; k <= 5; k += 1) {
      const idx = AT43_NIGHT - 5 + k;
      const factor = 0.98 ** k;
      await db.execute({
        sql: `UPDATE index_bar SET o_micro = CAST(o_micro * ? AS INTEGER), h_micro = CAST(h_micro * ? AS INTEGER),
                l_micro = CAST(l_micro * ? AS INTEGER), c_micro = CAST(c_micro * ? AS INTEGER)
              WHERE d = ?`,
        args: [factor, factor, factor, factor, dates[idx]!],
      });
    }
  }
}
