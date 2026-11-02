// @vitest-environment node
// AT-44 Rank quality and error budget (M14; docs/M14_design.md 5; VAL-112, VAL-114, VAL-115, VAL-116,
// KB-081, O-46; decisions D-226, D-230, D-231, D-232, D-233, D-234).
//
//   1 IC detects a planted edge: 500 sessions x 60 ZZ codes, seeded; next-day excess = 0.002 x rank
//     z-score + noise -> the 90 % interval excludes 0; the null twin's interval contains 0. The IC and
//     the block bootstrap are the functions `rankIcStage.ts` calls (dailyRankIc, summariseRankIc).
//   2 VAL-112 level: W0 / 2^k, sum(alpha) <= 0.05, `fixed` mode = v1's 0.05 / (20 x 6).
//   3 Every hypothesis or variant is in the trial ledger: one lineage, 25 trials over two split versions
//     (a roll after the 20th): 13 challengers (3 KB-081 pre-registered F1 items released by
//     `releasePreRegistered`, 3 stop variants of which the design's "sizing variant" is the initial-stop
//     key), 9 validation accesses and 3 pattern tests -> 25 trial_ledger rows; the levels follow the
//     spending sequence on each split; a 4th stop/sizing variant in the quarter is refused
//     (`variant_quarter_cap`).
//   4 VAL-115 known answer N = 45 -> 5.0 +- 0.05 years and "too short"; VAL-116 exhausted status.
//
// Synthetic only (SEC-110): ZZ codes, invented numbers, a throwaway libSQL file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  alphaLevel,
  alphaSequence,
  poolExhausted,
  poolId,
  readPoolState,
} from "@/lib/learning/alphaInvesting";
import { createChallenger, VARIANT_QUARTER_CAP } from "@/lib/learning/challengerLifecycle";
import { PRE_REGISTERED, releasePreRegistered } from "@/lib/learning/preRegistered";
import { spendingLevel, validationLevelFor, wealthAfter } from "@/lib/stats/errorBudget";
import { validationLevel } from "@/lib/stats/gates";
import { minBacktestYears, minBtlLabel, SESSIONS_PER_YEAR_BTL } from "@/lib/stats/minBtl";
import { dailyRankIc, RANK_IC_BLOCK_SESSIONS, summariseRankIc } from "@/lib/stats/rankIc";
import {
  createLineageSplit,
  lineageId,
  rolledBudgetAtRoll,
  trialCounts,
  trialLedgerRow,
  type TrialLedgerRow,
} from "@/lib/stats/splits";
import { cleanupTempDbs } from "../../db/helpers";
import { weekdayCalendar } from "../../fixtures/stats/t13";
import {
  AT44_CODE_LIST,
  AT44_CODES,
  AT44_EDGE,
  AT44_SESSIONS,
  crossSections,
} from "../../fixtures/m14/at44CrossSections";
import {
  BASE,
  D0,
  f1With,
  insertSplit,
  LEARNING,
  MARKET,
  rows,
  world,
} from "../../learning/challengerFixtures";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
afterEach(cleanupTempDbs);

// ---- 1 IC detects a planted edge (VAL-114, D-232) -----------------------------------------------------------

describe("AT-44 1: the rank IC detects a planted edge and not its null twin", () => {
  const summaryOf = (edge: number, scope: string) => {
    const days = crossSections(edge, scope);
    expect(days).toHaveLength(AT44_SESSIONS);
    expect(days[0]!.scores).toHaveLength(AT44_CODES);
    const ics: number[] = [];
    for (const day of days) {
      const r = dailyRankIc(day.scores, day.forward, AT44_CODE_LIST);
      expect(r.n).toBe(AT44_CODES);
      if (r.ic !== null) ics.push(r.ic);
    }
    expect(ics).toHaveLength(AT44_SESSIONS);
    return summariseRankIc(ics, {
      scope: `rank_ic:${scope}`,
      block: RANK_IC_BLOCK_SESSIONS.monthly,
    });
  };

  it("planted edge 0.002 x z + noise: the 90 % interval of the median IC excludes 0", () => {
    const s = summaryOf(AT44_EDGE, "AU:F1:at44-planted");
    expect(s.nDays).toBe(AT44_SESSIONS);
    expect(s.lower90).toBeGreaterThan(0);
    expect(s.medianIc).toBeGreaterThan(0);
    expect(s.meanIc).toBeGreaterThan(0.05);
  });

  it("the null twin (same draws, edge 0): the interval contains 0", () => {
    const s = summaryOf(0, "AU:F1:at44-null");
    expect(s.nDays).toBe(AT44_SESSIONS);
    expect(s.lower90).toBeLessThan(0);
    expect(s.upper90).toBeGreaterThan(0);
  });

  it("is deterministic for a seed scope", () => {
    const a = summaryOf(AT44_EDGE, "AU:F1:at44-planted");
    const b = summaryOf(AT44_EDGE, "AU:F1:at44-planted");
    expect(a).toEqual(b);
  });
});

// ---- 2 VAL-112 level as the Owner chose (D-226, D-227) --------------------------------------------------------

const legacy = { alpha: 0.05, m: 20, lineages: 6 };
const W0 = 0.05;
const level = (k: number): number =>
  validationLevelFor({ mode: "alpha_spending", w0: W0, priorTests: k, legacy });

describe("AT-44 2: the VAL-112 level follows the spending sequence", () => {
  it("W_k = W0 / 2^k and alpha_k = W_k / (2 + W_k) for k = 0...", () => {
    for (let k = 0; k < 12; k += 1) {
      expect(wealthAfter(W0, k)).toBeCloseTo(W0 / 2 ** k, 15);
      expect(level(k)).toBeCloseTo(spendingLevel(W0 / 2 ** k), 15);
      expect(level(k)).toBeCloseTo(W0 / 2 ** k / (2 + W0 / 2 ** k), 15);
    }
    expect(level(0)).toBeCloseTo(0.024390243902439, 12);
    expect(level(1)).toBeCloseTo(0.012345679012346, 12);
  });

  it("the levels are decreasing and their sum stays below 0.05 (family-wise error per lineage)", () => {
    let sum = 0;
    for (let k = 0; k < 100; k += 1) {
      if (k > 0) expect(level(k)).toBeLessThan(level(k - 1));
      sum += level(k);
    }
    expect(sum).toBeLessThan(W0);
  });

  it("`fixed` mode reproduces v1's 0.05 / 20 / 6 whatever k is", () => {
    const v1 = validationLevel(0.05, 20, 6);
    expect(v1).toBeCloseTo(0.05 / 120, 15);
    for (const k of [0, 3, 19]) {
      expect(validationLevelFor({ mode: "fixed", w0: W0, priorTests: k, legacy })).toBe(v1);
    }
    expect(defaultAgentParams().stats.valErrorBudgetMode).toBe("alpha_spending");
    expect(defaultAgentParams().stats.valFwerPerLineage).toBe(W0);
  });
});

// ---- 3 Every hypothesis or variant is in the trial ledger (ARN-085, KB-081, O-46) -----------------------------

const LINEAGE = lineageId(MARKET, "F1");
const roomy = { ...LEARNING, maxChallengers: 20 };
const M = BASE.stats.trialBudgetPerLineage;

type Db = Awaited<ReturnType<typeof world>>["db"];

async function ledger(db: Db): Promise<TrialLedgerRow[]> {
  const r = await rows(
    db,
    "SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d FROM trial_ledger WHERE lineage_id = ?",
    [LINEAGE],
  );
  return r.map((x) => ({
    id: String(x.id),
    market: String(x.market),
    lineage_id: String(x.lineage_id),
    split_version: Number(x.split_version),
    kind: String(x.kind) as TrialLedgerRow["kind"],
    rule_version: x.rule_version === null ? null : String(x.rule_version),
    variant: x.variant === null ? null : String(x.variant),
    run_id: x.run_id === null ? null : String(x.run_id),
    d: String(x.d),
  }));
}

/** A validation access or pattern test charged to the ledger (the production row builder, same id rule). */
async function charge(
  db: Db,
  kind: "validation_access" | "pattern_test",
  split: number,
  n: number,
  d: string,
): Promise<TrialLedgerRow> {
  const row = trialLedgerRow({
    market: MARKET,
    lineage_id: LINEAGE,
    split_version: split,
    kind,
    rule_version: "F1.v1",
    variant: kind === "pattern_test" ? `pattern-${n}` : "F1",
    run_id: `run-${split}-${kind}-${n}`,
    d,
  });
  await db.execute({
    sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.market,
      row.lineage_id,
      row.split_version,
      row.kind,
      row.rule_version,
      row.variant,
      row.run_id,
      row.d,
    ],
  });
  return row;
}

const challenger = (db: Db, params: Record<string, number>, d: string, budgetTotal?: number) =>
  f1With(db, params).then((p) =>
    createChallenger(db, {
      market: MARKET,
      family: "F1",
      origin: "owner",
      params: p,
      lessonIds: [],
      d,
      actor: "u-owner",
      learning: roomy,
      stats: BASE.stats,
      ...(budgetTotal === undefined ? {} : { budgetTotal }),
    }),
  );

/** The level of every validation or pattern test on a split, in the (d, id) order the evidence runner uses. */
function levelsOn(all: readonly TrialLedgerRow[], split: number): number[] {
  const tests = all
    .filter(
      (r) =>
        r.split_version === split && (r.kind === "validation_access" || r.kind === "pattern_test"),
    )
    .sort((a, b) => (a.d !== b.d ? (a.d < b.d ? -1 : 1) : a.id < b.id ? -1 : 1));
  return tests.map((_, k) => level(k));
}

describe("AT-44 3: one lineage, 25 trials across two split versions", () => {
  it("13 challengers + 9 validation accesses + 3 pattern tests = 25 rows; levels restart at the roll; the 4th stop variant is refused", async () => {
    const { db, split: v1 } = await world(["F1"]);
    const stopKeys = ["f1_initial_stop_atr", "f1_trail_atr"];

    // -- split version 1: 20 trials (the whole first-split budget m) --
    // 3 KB-081 pre-registered F1 challengers, origin owner, charged at creation (D-233)
    const rel = await releasePreRegistered(db, {
      market: MARKET,
      d: D0,
      learning: roomy,
      stats: BASE.stats,
      families: ["F1"],
    });
    expect(rel.created).toHaveLength(PRE_REGISTERED.filter((x) => x.family === "F1").length);
    expect(rel.created).toHaveLength(3);
    expect(rel.skipped).toEqual([]);
    // 3 stop / sizing variants (O-46 counts stop, trail and sizing keys; F1's sizing-side key is the
    // initial stop): 2 x trail, 1 x initial stop
    expect(await challenger(db, { f1_trail_atr: 2.5 }, D0)).toMatchObject({ status: "created" });
    expect(await challenger(db, { f1_trail_atr: 3.5 }, D0)).toMatchObject({ status: "created" });
    expect(await challenger(db, { f1_initial_stop_atr: 2.5 }, D0)).toMatchObject({
      status: "created",
    });
    // the 4th stop / sizing variant of the quarter is refused, with room left in the budget
    const fourth = await challenger(db, { f1_initial_stop_atr: 1.75 }, "2026-11-02");
    expect(fourth).toMatchObject({ status: "refused", reason: "variant_quarter_cap" });
    expect(VARIANT_QUARTER_CAP).toBe(3);
    // 4 entry-key variants (not counted by the cap)
    for (const v of [1.3, 1.7, 2.1, 2.4]) {
      expect(await challenger(db, { f1_volume_ratio_min: v }, D0)).toMatchObject({
        status: "created",
      });
    }
    // 7 validation accesses and 3 pattern tests on split 1 (dated in order)
    const day = (i: number): string => `2026-10-${String(6 + i).padStart(2, "0")}`;
    for (let i = 0; i < 7; i += 1) await charge(db, "validation_access", v1.version, i, day(i));
    for (let i = 0; i < 3; i += 1) await charge(db, "pattern_test", v1.version, i, day(7 + i));

    let all = await ledger(db);
    const c1 = trialCounts(all, LINEAGE, v1.version);
    expect(c1.total).toBe(M);
    expect(c1.byKind).toEqual({
      validation_access: 7,
      holdout_access: 0,
      pattern_test: 3,
      challenger: 10,
      new_lineage: 0,
    });
    // the budget of split 1 is used up: one more challenger is refused
    expect(await challenger(db, { f1_rs_top_fraction: 0.15 }, "2026-10-19")).toMatchObject({
      status: "refused",
      reason: "budget_exhausted",
    });

    // -- the roll: split version 2 on a longer calendar (no validation overlap -> full budget) --
    const long = weekdayCalendar(2000 + 1100);
    const v2 = createLineageSplit({
      market: MARKET,
      family: "F1",
      calendar: long,
      maxHoldingUpper: 120,
      primaryRows: [],
      params: BASE.stats,
      version: v1.version + 1,
      reason: "roll",
    });
    expect(v2.version).toBe(2);
    await insertSplit(db, v2);
    const budget2 = rolledBudgetAtRoll(all, v1, v2, long, M);
    expect(budget2).toBe(M);

    // -- split version 2: 5 trials: 3 challengers and 2 validation accesses --
    for (const f of [0.12, 0.25, 0.28]) {
      expect(await challenger(db, { f1_rs_top_fraction: f }, "2026-10-19", budget2)).toMatchObject({
        status: "created",
      });
    }
    await charge(db, "validation_access", v2.version, 0, "2026-10-20");
    await charge(db, "validation_access", v2.version, 1, "2026-10-21");

    all = await ledger(db);
    expect(all).toHaveLength(25);
    const c2 = trialCounts(all, LINEAGE, v2.version);
    expect(c2.total).toBe(5);
    expect(c2.byKind.challenger).toBe(3);
    expect(c2.byKind.validation_access).toBe(2);
    const kinds = { challenger: 0, validation_access: 0, pattern_test: 0 };
    for (const r of all) kinds[r.kind as keyof typeof kinds] += 1;
    expect(kinds).toEqual({ challenger: 13, validation_access: 9, pattern_test: 3 });
    // every challenger row names its rule version; every stored challenger has a ledger row
    const ch = await rows(db, "SELECT rule_version_id FROM challenger ORDER BY id");
    expect(ch).toHaveLength(13);
    const charged = new Set(all.filter((r) => r.kind === "challenger").map((r) => r.rule_version));
    for (const c of ch) expect(charged.has(String(c.rule_version_id))).toBe(true);
    // stop / sizing variants in the quarter: exactly the cap (the refused one left no row)
    const stops = await rows(
      db,
      "SELECT r.params_json AS p FROM rule_version r WHERE r.family = 'F1' AND r.origin IN ('owner','challenger')",
    );
    const base = JSON.parse(
      String(
        (await rows(db, "SELECT params_json FROM rule_version WHERE id = 'F1.v1'"))[0]!.params_json,
      ),
    ) as Record<string, unknown>;
    const stopChanged = stops.filter((s) => {
      const p = JSON.parse(String(s.p)) as Record<string, unknown>;
      return stopKeys.some((k) => p[k] !== base[k]);
    });
    expect(stopChanged).toHaveLength(VARIANT_QUARTER_CAP);

    // -- VAL-112: the levels follow the spending sequence on each split version --
    const l1 = levelsOn(all, v1.version);
    const l2 = levelsOn(all, v2.version);
    expect(l1).toHaveLength(10);
    expect(l2).toHaveLength(2);
    l1.forEach((lv, k) => expect(lv).toBeCloseTo(spendingLevel(W0 / 2 ** k), 15));
    expect(l1[0]).toBeCloseTo(0.024390243902439, 12);
    expect(l1[9]).toBeCloseTo(spendingLevel(W0 / 512), 15);
    // the roll starts a new pool: back to k = 0
    expect(l2).toEqual([level(0), level(1)]);
    expect(l1.reduce((a, b) => a + b, 0) + l2.reduce((a, b) => a + b, 0)).toBeLessThan(2 * W0);
  });
});

// ---- 4 Also: VAL-115 known answer and VAL-116 exhausted status (D-230, D-231) ---------------------------------

describe("AT-44 4: MinBTL known answer and the lesson pool's exhausted status", () => {
  it("VAL-115: N = 45, SR* = 1 -> 5.0 +- 0.05 years and 'too short' for three years of data", () => {
    const years = minBacktestYears(45, 1);
    expect(Math.abs(years - 5.0)).toBeLessThanOrEqual(0.05);
    expect(minBacktestYears(1, 1)).toBe(0);
    const three = minBtlLabel(45, 1, 3 * SESSIONS_PER_YEAR_BTL);
    expect(three.label).toBe("too short");
    expect(three.availableYears).toBeCloseTo(3, 12);
    expect(three.minYears).toBeCloseTo(years, 12);
    expect(minBtlLabel(45, 1, 6 * SESSIONS_PER_YEAR_BTL).label).toBe("long enough");
    expect(defaultAgentParams().stats.minbtlTargetSharpe).toBe(1);
  });

  it("VAL-116: 10 % of the pool per test; exhausted when the next level would be below 0.005", async () => {
    const p = defaultAgentParams();
    const f = p.learning.l2AlphaSpendFraction;
    const w0 = p.learning.l2AlphaW0;
    expect(f).toBe(0.1);
    expect(alphaLevel(w0, f)).toBeCloseTo(0.1 * w0, 15);
    // a run of non-rejections (p = 1) spends the pool until the next level is < 0.005
    const seq = alphaSequence(
      w0,
      Array.from({ length: 40 }, () => 1),
      p.learning.l2AlphaPayout,
    );
    expect(seq.length).toBeGreaterThan(0);
    expect(seq.length).toBeLessThan(40);
    const last = seq[seq.length - 1]!;
    expect(poolExhausted(last.wAfter, f, p.learning.l2AlphaExhaustedLevel)).toBe(true);
    expect(alphaLevel(last.wAfter, f)).toBeLessThan(p.learning.l2AlphaExhaustedLevel);
    expect(alphaLevel(last.wBefore, f)).toBeGreaterThanOrEqual(p.learning.l2AlphaExhaustedLevel);
    for (const s of seq) expect(s.alphaJ).toBeCloseTo(f * s.wBefore, 15);

    // the stored-pool reader reports the status: a fresh pool at W0 is open; one whose next level
    // would be below the exhausted level is reported exhausted (no row is written)
    const { db } = await world(["F1"]);
    const open = await readPoolState(db, poolId(MARKET, "F1"), p);
    expect(open).toEqual({ seq: 0, wealth: w0, exhausted: false });
    const lowW0 = buildAgentParams((k: ConfigKey) =>
      k === "l2_alpha_w0" ? 0.04 : CONFIG_KEYS[k].default,
    );
    const closed = await readPoolState(db, poolId(MARKET, "F1"), lowW0);
    expect(closed).toEqual({ seq: 0, wealth: 0.04, exhausted: true });
  });
});
