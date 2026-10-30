// @vitest-environment node
// Deterministic challenger generator (M6 T9; ARN-065, ARN-085, KB-040; D-110 #20, #21, #47):
// development data only, seeded, no trial for a development replay, one trial for the winner.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAMILY_PARAM_KEYS, paramBounds } from "@/lib/agents/families/ruleSchema";
import {
  candidateSteps,
  generateChallenger,
  generatorSeed,
  gridStep,
  pickWinner,
  type DevelopmentEvaluation,
  type DevelopmentView,
  type Evaluated,
  type GenerateInput,
} from "@/lib/learning/challengerGenerator";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { cleanupTempDbs } from "../db/helpers";
import {
  BASE,
  D0,
  LEARNING,
  MARKET,
  incumbentParams,
  ownerChallenger,
  rows,
  world,
  f1With,
} from "./challengerFixtures";

afterEach(cleanupTempDbs);

const dev = (rowsN: number, blocks: number, meanExcess: number | null): DevelopmentEvaluation => ({
  split: "development",
  rows: rowsN,
  blocks,
  meanExcess,
});

/** A view whose development mean excess is a known function of the parameters; counts its calls. */
function planted(score: (p: Record<string, unknown>) => number | null, rowsN = 150, blocks = 20) {
  const seeds: bigint[] = [];
  const seen: Record<string, unknown>[] = [];
  const view: DevelopmentView = {
    async evaluate(params, seed) {
      seeds.push(seed);
      seen.push({ ...params });
      return dev(rowsN, blocks, score({ ...params }));
    },
  };
  return { view, seeds, seen };
}

const trailUp = (p: Record<string, unknown>) => 0.01 + 0.02 * ((p.f1_trail_atr as number) - 3);

const INPUT: GenerateInput = {
  market: MARKET,
  family: "F1",
  d: "2026-10-10", // a Saturday: the weekly learning run
  hints: [],
  learning: LEARNING,
  stats: BASE.stats,
};

describe("grid steps and candidates", () => {
  it("the step is 10 % of the range, whole and at least 1 for an integer key", async () => {
    expect(await gridStep("f1_trail_atr")).toBeCloseTo(0.2, 12); // range 2..4
    expect(await gridStep("f1_volume_ratio_min")).toBeCloseTo(0.18, 12); // range 1.2..3
    expect(await gridStep("f1_max_hold")).toBe(6); // 60..120, integer
    expect(await gridStep("reentry_block")).toBe(2); // 5..20 -> 1.5 -> 2
    expect(await gridStep("no_such_key")).toBeNull();
  });

  it("every candidate moves exactly one key one step, inside the bounds, in (key, direction) order", async () => {
    const { db } = await world();
    const inc = await incumbentParams(db);
    const cands = await candidateSteps("F1", inc, []);
    expect(cands.length).toBeGreaterThan(0);
    let last = "";
    for (const c of cands) {
      const [lo, hi] = paramBounds(c.key)!;
      expect(c.value).toBeGreaterThanOrEqual(lo);
      expect(c.value).toBeLessThanOrEqual(hi);
      const changed = Object.keys(inc).filter((k) => c.params[k] !== inc[k]);
      expect(changed).toEqual([c.key]);
      expect(Math.abs((c.value as number) - (inc[c.key] as number))).toBeCloseTo(
        (await gridStep(c.key))!,
        9,
      );
      const order = `${c.key}|${c.direction}`;
      expect(order > last).toBe(true);
      last = order;
      expect(FAMILY_PARAM_KEYS.F1).toContain(c.key);
    }
    // f1_max_hold sits at its upper bound: only the downward step exists
    expect(cands.filter((c) => c.key === "f1_max_hold").map((c) => c.direction)).toEqual(["down"]);
    expect(cands.find((c) => c.key === "f1_max_hold")!.value).toBe(114);
    expect(Number.isInteger(cands.find((c) => c.key === "reentry_block")!.value)).toBe(true);
  });

  it("marks the keys named by lesson hints", async () => {
    const { db } = await world();
    const cands = await candidateSteps("F1", await incumbentParams(db), [
      { lessonId: "L-1", key: "f1_trail_atr" },
    ]);
    expect(new Set(cands.filter((c) => c.hinted).map((c) => c.key))).toEqual(
      new Set(["f1_trail_atr"]),
    );
  });
});

describe("the winner", () => {
  const cand = (key: string, direction: "down" | "up", hinted = false) => ({
    key,
    direction,
    value: 1,
    hinted,
    params: { [key]: 1 },
  });
  const ev = (c: ReturnType<typeof cand>, r: number, b: number, m: number | null): Evaluated => ({
    candidate: c,
    evaluation: dev(r, b, m),
  });
  const S = { minTrades: BASE.stats.minTrades, minBlocks: BASE.stats.minBlocks };

  it("needs min_trades rows and min_blocks blocks (100 and 15 by default)", () => {
    expect([S.minTrades, S.minBlocks]).toEqual([100, 15]);
    const a = cand("a", "up");
    expect(pickWinner([ev(a, 99, 20, 0.5)], 0, S)).toBeNull();
    expect(pickWinner([ev(a, 100, 14, 0.5)], 0, S)).toBeNull();
    expect(pickWinner([ev(a, 100, 15, 0.5)], 0, S)).toBe(a);
    expect(pickWinner([ev(a, 100, 15, null)], 0, S)).toBeNull();
  });
  it("must beat the incumbent's development mean excess", () => {
    const a = cand("a", "up");
    expect(pickWinner([ev(a, 150, 20, 0.02)], 0.02, S)).toBeNull();
    expect(pickWinner([ev(a, 150, 20, 0.021)], 0.02, S)).toBe(a);
    expect(pickWinner([ev(a, 150, 20, -0.5)], null, S)).toBe(a); // no baseline: the best qualifying
  });
  it("best mean excess; ties by key name, then direction (down before up)", () => {
    const a = cand("a", "up"),
      b = cand("b", "down"),
      a2 = cand("a", "down");
    expect(pickWinner([ev(a, 150, 20, 0.03), ev(b, 150, 20, 0.05)], 0, S)).toBe(b);
    expect(pickWinner([ev(b, 150, 20, 0.05), ev(a, 150, 20, 0.05)], 0, S)).toBe(a);
    expect(pickWinner([ev(a, 150, 20, 0.05), ev(a2, 150, 20, 0.05)], 0, S)).toBe(a2);
  });
  it("hinted keys form the first tier, even with a lower mean; unhinted win only when no hinted qualifies", () => {
    const h = cand("h", "up", true),
      u = cand("u", "up");
    expect(pickWinner([ev(u, 150, 20, 0.09), ev(h, 150, 20, 0.02)], 0, S)).toBe(h);
    expect(pickWinner([ev(u, 150, 20, 0.09), ev(h, 50, 20, 0.5)], 0, S)).toBe(u);
  });
});

describe("seed", () => {
  it("is the same for a lineage and ISO week and differs across weeks and lineages", () => {
    const s = generatorSeed("AU:F1", "2026-10-05");
    expect(generatorSeed("AU:F1", "2026-10-11")).toBe(s);
    expect(generatorSeed("AU:F1", "2026-10-12")).not.toBe(s);
    expect(generatorSeed("AU:F2", "2026-10-05")).not.toBe(s);
    expect(s).toBeGreaterThanOrEqual(0n);
    expect(s).toBeLessThan(2n ** 64n);
  });
});

describe("generation", () => {
  it("proposes the best development step: deterministic, one trial, lesson ids, parent = incumbent", async () => {
    const { db } = await world();
    const p = planted(trailUp);
    const r = await generateChallenger(db, p.view, {
      ...INPUT,
      hints: [
        { lessonId: "L-7", key: "f1_trail_atr" },
        { lessonId: "L-3", key: "f1_trail_atr" },
        { lessonId: "L-5", key: "f1_max_hold" },
      ],
    });
    expect(r).toMatchObject({
      status: "proposed",
      id: "C-AU-F1-2",
      key: "f1_trail_atr",
      direction: "up",
    });
    const v = (
      await rows(
        db,
        "SELECT params_json, origin, parent, registered_d FROM rule_version WHERE id = 'F1.v2'",
      )
    )[0]!;
    expect(v).toMatchObject({ origin: "challenger", parent: "F1.v1", registered_d: "2026-10-10" });
    expect((JSON.parse(String(v.params_json)) as Record<string, number>).f1_trail_atr).toBeCloseTo(
      3.2,
      9,
    );
    expect((await rows(db, "SELECT lesson_ids_json, origin, state FROM challenger"))[0]).toEqual({
      lesson_ids_json: '["L-3","L-7"]',
      origin: "generator",
      state: "proposed",
    });
    // the development replays charged nothing; the only trial is the winner's own (ARN-085)
    expect(await rows(db, "SELECT kind FROM trial_ledger")).toEqual([{ kind: "challenger" }]);
    // one call for the incumbent, one per candidate, all with the same seed
    const cands = await candidateSteps("F1", await incumbentParams(db), []);
    expect(p.seeds).toHaveLength(1 + cands.length);
    expect(new Set(p.seeds).size).toBe(1);
    expect(p.seeds[0]).toBe(generatorSeed("AU:F1", "2026-10-10"));
  });

  it("two independent databases with the same development data give the same challenger", async () => {
    const a = await world(),
      b = await world();
    const ra = await generateChallenger(a.db, planted(trailUp).view, INPUT);
    const rb = await generateChallenger(b.db, planted(trailUp).view, INPUT);
    expect(ra).toEqual(rb);
    const pj = async (db: typeof a.db) =>
      (await rows(db, "SELECT params_json, params_sha FROM rule_version WHERE id = 'F1.v2'"))[0];
    expect(await pj(a.db)).toEqual(await pj(b.db));
  });

  it("a view that returns anything but the development split is refused; nothing is written", async () => {
    const { db } = await world();
    const evil = {
      async evaluate() {
        return { ...dev(150, 20, 1), split: "validation" } as unknown as DevelopmentEvaluation;
      },
    };
    await expect(generateChallenger(db, evil, INPUT)).rejects.toThrow(/development split only/);
    expect(await rows(db, "SELECT id FROM trial_ledger")).toHaveLength(0);
    expect(await rows(db, "SELECT id FROM challenger")).toHaveLength(0);
  });

  it("module boundary: the generator reaches no validation or holdout reader", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../src/lib/learning/challengerGenerator.ts"),
      "utf8",
    );
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.sort()).toEqual(
      [
        "@/lib/agents/families/ruleSchema",
        "@/lib/agents/params",
        "@/lib/agents/schema",
        "@/lib/config/keys",
        "@/lib/stats/splits",
        "./challengerLifecycle",
        "@libsql/client",
        "node:crypto",
      ].sort(),
    );
    expect(src).not.toMatch(
      /evaluateVal110|evaluateHoldout|validation_result|ledger_row|holdout_access/,
    );
  });

  it("nothing qualifies -> none, no trial", async () => {
    const { db } = await world();
    expect(await generateChallenger(db, planted(trailUp, 99, 20).view, INPUT)).toMatchObject({
      status: "none",
    });
    expect(await generateChallenger(db, planted(() => 0.01).view, INPUT)).toMatchObject({
      status: "none",
    }); // no step beats the incumbent
    expect(await generateChallenger(db, planted(() => null).view, INPUT)).toMatchObject({
      status: "none",
    });
    expect(await rows(db, "SELECT id FROM trial_ledger")).toHaveLength(0);
  });

  it("a hinted key wins its tier over a better unhinted step", async () => {
    const { db } = await world();
    const score = (p: Record<string, unknown>) =>
      p.f1_trail_atr === 3.2 ? 0.5 : p.f1_max_hold === 114 ? 0.02 : 0.01;
    const r = await generateChallenger(db, planted(score).view, {
      ...INPUT,
      hints: [{ lessonId: "L-5", key: "f1_max_hold" }],
    });
    expect(r).toMatchObject({ status: "proposed", key: "f1_max_hold", direction: "down" });
  });

  it("is blocked, and never replays, for a frozen family, a full market, an exhausted budget, a second run in the week, no incumbent or no split", async () => {
    const mk = async () => {
      const w = await world();
      const p = planted(trailUp);
      return { ...w, p };
    };
    {
      const { db, p } = await mk();
      await db.execute(
        "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('family','F1','killed','2026-10-05T00:00:00.000Z','k')",
      );
      expect(await generateChallenger(db, p.view, INPUT)).toEqual({
        status: "blocked",
        reason: "family_frozen",
        evaluated: 0,
      });
      expect(p.seen).toHaveLength(0);
    }
    {
      const { db, p } = await mk();
      // O-46: trail changes are capped per quarter, so the slots are filled with a non-stop key
      for (let i = 0; i < LEARNING.maxChallengers; i += 1) {
        await ownerChallenger(db, i, undefined, {
          params: await f1With(db, { f1_volume_ratio_min: 1.5 + 0.05 * (i + 1) }),
        });
      }
      expect(await generateChallenger(db, p.view, INPUT)).toMatchObject({
        status: "blocked",
        reason: "max_challengers",
      });
      expect(p.seen).toHaveLength(0);
    }
    {
      const { db, p } = await mk();
      const stats = { ...BASE.stats, trialBudgetPerLineage: 1 };
      await ownerChallenger(db, 0, D0, { stats });
      expect(await generateChallenger(db, p.view, { ...INPUT, stats })).toMatchObject({
        status: "blocked",
        reason: "budget_exhausted",
      });
      expect(p.seen).toHaveLength(0);
    }
    {
      const { db, p } = await mk();
      expect(await generateChallenger(db, p.view, INPUT)).toMatchObject({ status: "proposed" });
      const again = planted(trailUp);
      expect(await generateChallenger(db, again.view, INPUT)).toMatchObject({
        status: "blocked",
        reason: "weekly_generator_cap",
      });
      expect(again.seen).toHaveLength(0);
      expect(await rows(db, "SELECT id FROM trial_ledger")).toHaveLength(1);
    }
    {
      const { db, p } = await mk();
      expect(await generateChallenger(db, p.view, { ...INPUT, family: "F2" })).toMatchObject({
        status: "blocked",
        reason: "no_split",
      });
      expect(await generateChallenger(db, p.view, { ...INPUT, market: "IN" })).toMatchObject({
        status: "blocked",
        reason: "no_split",
      });
    }
  });

  it("the next ISO week may generate again; the new winner builds on the same incumbent", async () => {
    const { db } = await world();
    await generateChallenger(db, planted(trailUp).view, INPUT);
    // reject the first so the second is not a duplicate-slot question, then run the following Saturday
    await transitionChallenger(
      db,
      { id: "C-AU-F1-2", to: "rejected", d: "2026-10-12", actor: "A6", reason: "x" },
      LEARNING,
    );
    const r = await generateChallenger(
      db,
      planted((p) => 0.01 + 0.02 * (3 - (p.f1_trail_atr as number))).view,
      { ...INPUT, d: "2026-10-17" },
    );
    expect(r).toMatchObject({ status: "proposed", id: "C-AU-F1-3", direction: "down" });
    expect(await rows(db, "SELECT kind FROM trial_ledger")).toHaveLength(2);
  });
});
