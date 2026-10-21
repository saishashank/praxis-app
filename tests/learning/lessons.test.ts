// @vitest-environment node
// Lesson engine (M6 T4; ARN-063, KB-020): windows, L0 / L1 / L2 grading, retire rules, wording,
// determinism, idempotent writes and look-ahead.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { canonicalJson } from "@/lib/arena/cohort";
import {
  buildCandidates,
  runLessons,
  statementOf,
  STATE_ALPHA_EXHAUSTED,
  STATE_DEFERRED,
  STATE_L2_UNREACHABLE,
  type LessonRunInput,
  type LineageInput,
} from "@/lib/learning/lessons";
import {
  GRADE_VERB,
  holdEdges,
  lessonId,
  LESSON_TEMPLATES_V1,
  renderStatement,
  templateKey,
  type LessonGradeName,
  type LessonObs,
} from "@/lib/learning/templates";
import {
  assertDevelopment,
  crossFamilyWindows,
  freezeLessonWindow,
  lessonWindowRow,
  rowsInWindow,
  splitLessonWindows,
} from "@/lib/learning/windows";
import { circularBlockBootstrap, percentile } from "@/lib/stats/bootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { ARENA_MASTER_SEED } from "@/lib/arena/closeBooks";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();
const MARKET = "AU";

const day = (i: number): string => {
  const t = new Date(Date.UTC(2024, 0, 1));
  t.setUTCDate(t.getUTCDate() + i);
  return t.toISOString().slice(0, 10);
};
const sessions = (n: number): string[] => Array.from({ length: n }, (_, i) => day(i));

/** Deterministic noise in [-1, 1). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

const NOW = day(400);

function obs(
  id: string,
  d: string,
  over: Partial<LessonObs> & { excess?: number | null } = {},
): LessonObs {
  const excess = over.excess === undefined ? 0 : over.excess;
  return {
    part: "development",
    id,
    entryD: d,
    observedD: d,
    family: "F1",
    kind: "executed",
    excess,
    net: excess ?? 0,
    stressExcess: excess === null ? null : excess - 0.002,
    regime: "bull",
    tier: "U1",
    exitKind: "IS",
    holdSessions: 5,
    blockedBy: null,
    evidenceClasses: [],
    ...over,
  };
}

/** Bull sessions earn +1 %, bear sessions -1 % (two rows per session, two tiers). */
function effectWorld(dev: readonly string[], seed = 7, family = "F1", tag = ""): LessonObs[] {
  const n = noise(seed);
  const out: LessonObs[] = [];
  dev.forEach((d, k) => {
    for (let j = 0; j < 2; j += 1) {
      const bull = k % 2 === 0;
      out.push(
        obs(`${tag}${family}-${String(k)}-${String(j)}`, d, {
          family,
          excess: (bull ? 0.01 : -0.01) + n() * 0.004,
          regime: bull ? "bull" : "bear",
          tier: j === 0 ? "U1" : "U2",
          holdSessions: 5 + (k % 9),
        }),
      );
    }
  });
  return out;
}

const DEV = sessions(252);
const WIN = splitLessonWindows(DEV, 10)!;

const lineage = (over: Partial<LineageInput> = {}): LineageInput => ({
  family: "F1",
  lineageId: "AU:F1",
  ruleVersion: "F1.v1",
  splitVersion: 1,
  windows: WIN,
  block: 5,
  ...over,
});

function input(over: Partial<LessonRunInput> = {}): LessonRunInput {
  return {
    market: MARKET,
    runId: "learn-1",
    d: NOW,
    asOfD: NOW,
    params,
    rows: effectWorld(DEV),
    lineages: [lineage()],
    ...over,
  };
}

describe("lesson windows (first two thirds / purge / last third)", () => {
  it("252 sessions, purge 10: 161 + 10 + 81, contiguous and disjoint", () => {
    expect(WIN.l1).toHaveLength(161); // floor(2 * 242 / 3)
    expect(WIN.purge).toHaveLength(10);
    expect(WIN.l2).toHaveLength(81);
    expect([...WIN.l1, ...WIN.purge, ...WIN.l2]).toEqual(DEV);
  });

  it("another known answer, deferral, and degenerate splits", () => {
    const w = splitLessonWindows(sessions(100), 40)!;
    expect([w.l1.length, w.purge.length, w.l2.length]).toEqual([40, 40, 20]);
    expect(splitLessonWindows(sessions(100), 40, true)).toBeNull();
    expect(splitLessonWindows(sessions(40), 40)).toBeNull();
    expect(splitLessonWindows(sessions(1), 0)).toBeNull();
    expect(() => splitLessonWindows(["2024-01-02", "2024-01-01"], 0)).toThrow(/ascending/);
  });

  it("cross-family windows take the earliest date per boundary", () => {
    const a = splitLessonWindows(sessions(252), 10)!;
    const b = splitLessonWindows(sessions(252).slice(20), 30)!;
    const x = crossFamilyWindows([a, b])!;
    const mn = (u: string, v: string): string => (u < v ? u : v);
    expect(x.l1[0]).toBe(mn(a.l1[0]!, b.l1[0]!));
    expect(x.l1[x.l1.length - 1]).toBe(mn(a.l1[a.l1.length - 1]!, b.l1[b.l1.length - 1]!));
    expect(x.l2[0]).toBe(mn(a.l2[0]!, b.l2[0]!));
    expect(x.l2[x.l2.length - 1]).toBe(mn(a.l2[a.l2.length - 1]!, b.l2[b.l2.length - 1]!));
    expect(x.l1[x.l1.length - 1]! < x.l2[0]!).toBe(true);
  });

  it("rows count only inside the window and once observed; non-development rows are refused", () => {
    const rows = [
      obs("in", WIN.l1[3]!),
      obs("late", WIN.l1[3]!, { observedD: "2030-01-01" }),
      obs("purge", WIN.purge[0]!),
      obs("l2", WIN.l2[0]!),
    ];
    const w = rowsInWindow(rows, WIN.l1, NOW);
    expect(w.rows.map((r) => r.id)).toEqual(["in"]);
    expect(w.sessions).toEqual([3]);
    expect(() =>
      assertDevelopment([{ part: "validation" }] as unknown as { part: string }[]),
    ).toThrow(/development/);
  });

  it("freezing a window is idempotent and a different window at the same version raises", async () => {
    const db = await freshDb("main");
    const row = lessonWindowRow("AU:F1", 1, WIN, 5, "run-1");
    expect(await freezeLessonWindow(db, row)).toBe("inserted");
    expect(await freezeLessonWindow(db, row)).toBe("unchanged");
    await expect(freezeLessonWindow(db, { ...row, block: 6 })).rejects.toThrow(/block differs/);
  });
});

describe("grading on the L1 window", () => {
  const cell = (c: ReturnType<typeof buildCandidates>["candidates"], tpl: string, key: string) =>
    c.find((x) => x.template.id === tpl && canonicalJson(x.subject).includes(key))!;

  it("a planted regime effect is L1 with the sign of its estimate", () => {
    const { candidates } = buildCandidates(input());
    const bull = cell(candidates, "LT-REGIME", "bull");
    const bear = cell(candidates, "LT-REGIME", "bear");
    expect(bull.l1.grade).toBe("L1");
    expect(bull.l1.direction).toBe(1);
    expect(bull.l1.lower!).toBeGreaterThan(0);
    expect(bear.l1.grade).toBe("L1");
    expect(bear.l1.direction).toBe(-1);
    expect(bear.l1.upper!).toBeLessThan(0);
    // 161 session window, block 5: 32 blocks >= 15.
    expect(bull.l1.blocks).toBe(32);
    expect(bull.l2?.status).toBe("ready");
    expect(bull.lesson.direction).toBe(1);
    expect(bull.id).toBe(lessonId(MARKET, "LT-REGIME", { regime: "bull" }, "F1.v1"));
    expect(bull.id).toMatch(/^L-AU-LT-REGIME-[0-9a-f]{8}-F1\.v1$/);
  });

  it("L1 interval known answers: constant values give a degenerate interval; a zero-mean cell stays L0", () => {
    const l1 = WIN.l1;
    const rows: LessonObs[] = [];
    l1.forEach((d, k) => {
      rows.push(obs(`c${String(k)}`, d, { regime: "const", excess: 0.02 }));
      rows.push(obs(`z${String(k)}`, d, { regime: "zero", excess: k % 2 === 0 ? 0.01 : -0.01 }));
    });
    const { candidates } = buildCandidates(input({ rows }));
    const c = cell(candidates, "LT-REGIME", "const");
    expect(c.l1.grade).toBe("L1");
    expect(c.l1.estimate).toBeCloseTo(0.02, 12);
    expect(c.l1.lower).toBeCloseTo(0.02, 12);
    expect(c.l1.upper).toBeCloseTo(0.02, 12);
    expect(c.l1.B).toBe(1000);
    const z = cell(candidates, "LT-REGIME", "zero");
    expect(z.l1.grade).toBe("L0");
    expect(z.l1.stateText).toBe("90 % interval includes 0");
    expect(z.l1.lower!).toBeLessThan(0);
    expect(z.l1.upper!).toBeGreaterThan(0);
  });

  it("the interval is the 5th / 95th percentile of the seeded block-bootstrap replicate means", () => {
    const l1 = WIN.l1;
    const n = noise(3);
    const rows = l1.map((d, k) =>
      obs(`p${String(k)}`, d, { regime: "r", excess: 0.003 + n() * 0.01 }),
    );
    const { candidates } = buildCandidates(input({ rows }));
    const c = cell(candidates, "LT-REGIME", '"r"');
    const r = circularBlockBootstrap(
      {
        sessions: rows.map((_, k) => k),
        sessionCount: l1.length,
        block: 5,
        replicates: 1000,
        series: [rows.map((x) => x.excess!)],
      },
      scopedPrng(`lesson:${c.id}:1`, ARENA_MASTER_SEED),
    );
    expect(c.l1.lower).toBe(percentile(r.replicateMeans[0]!, 0.05));
    expect(c.l1.upper).toBe(percentile(r.replicateMeans[0]!, 0.95));
  });

  it("n >= 10 for L0 and n >= 30 for L1 at the boundary", () => {
    const build = (k: number) => {
      const rows: LessonObs[] = [];
      WIN.l1.forEach((d, i) => {
        rows.push(
          obs(`o${String(i)}`, d, {
            regime: "other",
            excess: 0.0 + (i % 2 === 0 ? 0.001 : -0.001),
          }),
        );
        if (i < k) rows.push(obs(`x${String(i)}`, d, { regime: "edge", excess: 0.02 }));
      });
      return buildCandidates(input({ rows })).candidates.filter((c) =>
        canonicalJson(c.subject).includes("edge"),
      );
    };
    expect(build(9)).toHaveLength(0);
    const ten = build(10);
    expect(ten).toHaveLength(1);
    expect(ten[0]!.l1.grade).toBe("L0");
    expect(ten[0]!.l1.n).toBe(10);
    expect(build(29)[0]!.l1.grade).toBe("L0");
    expect(build(29)[0]!.l1.stateText).toBe(
      "fewer than 30 relevant rows in the L1 window (n = 29)",
    );
    expect(build(30)[0]!.l1.grade).toBe("L1");
  });

  it("fewer than 15 independent blocks stays L0", () => {
    const { candidates } = buildCandidates(input({ lineages: [lineage({ block: 12 })] }));
    const bull = cell(candidates, "LT-REGIME", "bull");
    expect(bull.l1.grade).toBe("L0");
    expect(bull.l1.stateText).toMatch(/^insufficient independent blocks/);
    expect(bull.l2).toBeNull();
  });

  it("a deferred split gives L0 lessons only, on all development sessions", () => {
    const { candidates } = buildCandidates(
      input({
        lineages: [lineage({ windows: null, devSessions: DEV, splitVersion: 0 })],
      }),
    );
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.l1.grade).toBe("L0");
      expect(c.l1.stateText).toBe(STATE_DEFERRED);
      expect(c.l2).toBeNull();
    }
  });

  it("L2 with too few rows is 'not reachable' and names the next roll", () => {
    const rows = effectWorld(DEV).filter(
      (r) => !(WIN.l2.includes(r.entryD) && r.regime === "bull" && r.entryD > WIN.l2[10]!),
    );
    const { candidates } = buildCandidates(input({ rows, nextRollD: "2025-06-02" }));
    const bull = cell(candidates, "LT-REGIME", "bull");
    expect(bull.l2?.status).toBe("unreachable");
    if (bull.l2?.status === "unreachable") {
      expect(bull.l2.stateText).toContain(STATE_L2_UNREACHABLE);
      expect(bull.l2.stateText).toContain("2025-06-02");
      expect(bull.l2.reachableD).toBe("2025-06-02");
    }
  });

  it("the other templates produce cells: cost drag, holding terciles, filters and classes", () => {
    const n = noise(11);
    const rows: LessonObs[] = [];
    DEV.forEach((d, k) => {
      rows.push(
        obs(`e${String(k)}`, d, {
          family: "F6",
          excess: 0.012 + n() * 0.004,
          evidenceClasses: k % 2 === 0 ? ["a", "b"] : ["b"],
          holdSessions: 3 + (k % 9),
          exitKind: k % 3 === 0 ? "TB" : "IS",
        }),
      );
      rows.push(
        obs(`b${String(k)}`, d, {
          family: "F6",
          kind: "blocked",
          excess: null,
          net: -0.01 + n() * 0.004,
          blockedBy: "F6.gate",
          regime: null,
        }),
      );
    });
    const { candidates } = buildCandidates(
      input({
        rows,
        lineages: [lineage({ family: "F6", lineageId: "AU:F6", ruleVersion: "F6.v1" })],
      }),
    );
    const ids = new Set(candidates.map((c) => c.template.id));
    expect([...ids].sort()).toEqual(
      ["LT-CLASS", "LT-COST", "LT-EXIT", "LT-FILTER", "LT-HOLD", "LT-REGIME", "LT-TIER"].sort(),
    );
    const filter = candidates.find((c) => c.template.id === "LT-FILTER")!;
    expect(filter.l1.direction).toBe(-1);
    expect(filter.lesson.param_hint).toBe("filter:F6.gate");
    const cost = candidates.find((c) => c.template.id === "LT-COST")!;
    expect(cost.l1.estimate).toBeCloseTo(-0.002, 12);
    expect(candidates.filter((c) => c.template.id === "LT-HOLD")).toHaveLength(3);
    expect(candidates.find((c) => c.template.id === "LT-HOLD")!.lesson.param_hint).toBe(
      "f6_max_hold",
    );
    const cls = candidates.filter((c) => c.template.id === "LT-CLASS");
    expect(cls).toHaveLength(1);
    // class "b" is on every row: the absent side is empty, so there is no cell for it.
    expect(holdEdges([1, 2, 3, 4, 5, 6])).toEqual([2, 4]);
    expect(holdEdges([1, 2])).toBeNull();
  });

  it("a market-scope lesson uses the cross-family windows and the market pool", () => {
    const w2 = splitLessonWindows(DEV, 20)!;
    const rows = [
      ...effectWorld(DEV, 7, "F1"),
      ...effectWorld(DEV, 9, "F2").map((r) => ({
        ...r,
        excess: 0.0005 * (r.regime === "bull" ? 1 : -1),
      })),
    ];
    const { candidates, splits } = buildCandidates(
      input({
        rows,
        lineages: [
          lineage(),
          lineage({
            family: "F2",
            lineageId: "AU:F2",
            ruleVersion: "F2.v1",
            windows: w2,
            splitVersion: 3,
          }),
        ],
      }),
    );
    const m = candidates.find((c) => c.template.id === "LT-EVTECH")!;
    expect(m.pool).toBe("AU:*");
    expect(m.lesson.lineage_id).toBeNull();
    expect(m.id).toMatch(/-all$/);
    expect(m.splitVersion).toBe(3);
    expect(splits.get("*")).toBe(3);
    expect(m.l1.n).toBeGreaterThanOrEqual(30);
  });
});

describe("determinism and look-ahead", () => {
  it("the same input gives byte-identical candidates", () => {
    const a = JSON.stringify(buildCandidates(input()).candidates.map((c) => [c.id, c.l1, c.l2]));
    const b = JSON.stringify(buildCandidates(input()).candidates.map((c) => [c.id, c.l1, c.l2]));
    expect(a).toBe(b);
  });

  const summary = (i: LessonRunInput) =>
    JSON.stringify(buildCandidates(i).candidates.map((c) => [c.id, c.l1, c.l2]));

  it("rows entered or observed after the as-of date, or outside the windows, change nothing", () => {
    const base = summary(input());
    const noisy: LessonObs[] = [
      ...effectWorld(DEV),
      obs("future-obs", WIN.l1[5]!, { regime: "bull", excess: 5, observedD: "2031-01-01" }),
      obs("future-entry", day(300), { regime: "bull", excess: 5 }),
      obs("purge", WIN.purge[2]!, { regime: "bull", excess: 5 }),
      obs("early", day(-30), { regime: "bull", excess: 5 }),
    ];
    expect(summary(input({ rows: noisy }))).toBe(base);
  });

  it("L2-window data cannot change the L1 assessment", () => {
    const l2set = new Set(WIN.l2);
    const a = buildCandidates(input()).candidates;
    const b = buildCandidates(
      input({
        rows: effectWorld(DEV).map((r) => (l2set.has(r.entryD) ? { ...r, excess: 9 } : r)),
      }),
    ).candidates;
    expect(JSON.stringify(a.map((c) => [c.id, c.l1]))).toBe(
      JSON.stringify(b.map((c) => [c.id, c.l1])),
    );
  });

  it("validation or holdout rows are refused", () => {
    const rows = [
      ...effectWorld(DEV),
      { ...obs("v", WIN.l1[0]!), part: "validation" } as unknown as LessonObs,
    ];
    expect(() => buildCandidates(input({ rows }))).toThrow(/development rows only/);
  });
});

describe("writing: L2 through alpha-investing, idempotence, conflicts", () => {
  it("grades every lesson, tests in (pool, id) order, and chains the wealth", async () => {
    const db = await freshDb("main");
    const rep = await runLessons(db, input());
    expect(rep.lessonsCreated).toBeGreaterThan(0);
    expect(rep.testsWritten).toBeGreaterThanOrEqual(3);
    const tests = (await db.execute("SELECT * FROM alpha_wealth WHERE pool = 'AU:F1' ORDER BY seq"))
      .rows;
    expect(tests.map((t) => String(t.lesson_id))).toEqual(
      tests.map((t) => String(t.lesson_id)).sort(),
    );
    expect(Number(tests[0]!.w_before)).toBe(0.1);
    tests.forEach((t, i) => {
      if (i > 0) expect(Number(t.w_before)).toBe(Number(tests[i - 1]!.w_after));
      expect(Number(t.rejected)).toBe(1);
    });
    const grades = (
      await db.execute(
        `SELECT l.template_id, g.grade, g.state_text FROM lesson l JOIN lesson_grade g ON g.lesson_id = l.id
        AND g.seq = (SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = l.id) WHERE l.template_id = 'LT-REGIME'`,
      )
    ).rows;
    expect(grades.map((g) => String(g.grade))).toEqual(["L2", "L2"]);
    expect(String(grades[0]!.state_text)).toMatch(/^L2 test passed \(L2 window /);
  });

  it("a second identical run writes nothing (idempotent), a changed value raises", async () => {
    const db = await freshDb("main");
    await runLessons(db, input());
    const count = async () => [
      Number((await db.execute("SELECT COUNT(*) AS n FROM lesson")).rows[0]!.n),
      Number((await db.execute("SELECT COUNT(*) AS n FROM lesson_grade")).rows[0]!.n),
      Number((await db.execute("SELECT COUNT(*) AS n FROM alpha_wealth")).rows[0]!.n),
    ];
    const before = await count();
    const rep = await runLessons(db, input({ runId: "learn-2", d: day(401) }));
    expect(await count()).toEqual(before);
    expect(rep.gradesWritten + rep.lessonsCreated + rep.testsWritten).toBe(0);
    expect(rep.testsExisting).toBeGreaterThan(0);
    // The same split version with different data raises instead of rewriting history.
    const other = effectWorld(DEV, 99).map((r) =>
      r.regime === "bull" ? { ...r, excess: (r.excess ?? 0) * 0.5 } : r,
    );
    await expect(runLessons(db, input({ rows: other, runId: "learn-3" }))).rejects.toThrow(
      /differs from the recomputation|stored p/,
    );
    expect(await count()).toEqual(before);
  });

  it("wealth carries across a roll: the new split tests continue the pool, never reset", async () => {
    const db = await freshDb("main");
    await runLessons(db, input());
    const first = (await db.execute("SELECT * FROM alpha_wealth WHERE pool = 'AU:F1' ORDER BY seq"))
      .rows;
    const last = Number(first[first.length - 1]!.w_after);
    const rep = await runLessons(
      db,
      input({ runId: "learn-roll", d: day(500), lineages: [lineage({ splitVersion: 2 })] }),
    );
    expect(rep.testsWritten).toBe(first.length);
    const all = (await db.execute("SELECT * FROM alpha_wealth WHERE pool = 'AU:F1' ORDER BY seq"))
      .rows;
    expect(all).toHaveLength(first.length * 2);
    expect(Number(all[first.length]!.w_before)).toBe(last);
    expect(Number(all[first.length]!.w_before)).toBeGreaterThan(0.1);
    // Old grades keep their split stamp.
    const stamps = (
      await db.execute("SELECT DISTINCT split_version AS s FROM lesson_grade ORDER BY s")
    ).rows;
    expect(stamps.map((s) => Number(s.s))).toEqual([1, 2]);
  });

  it("an exhausted pool leaves the lesson at L1 with a provisional row, later superseded", async () => {
    const db = await freshDb("main");
    const dead = { ...params, learning: { ...params.learning, l2AlphaW0: 0 } };
    const rep = await runLessons(db, input({ params: dead }));
    expect(rep.exhausted).toBeGreaterThan(0);
    expect((await db.execute("SELECT COUNT(*) AS n FROM alpha_wealth")).rows[0]!.n).toBe(0);
    const rows = (
      await db.execute({
        sql: "SELECT grade, state_text FROM lesson_grade WHERE state_text = ?",
        args: [STATE_ALPHA_EXHAUSTED],
      })
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.grade === "L1")).toBe(true);
    // Idempotent while still exhausted.
    const again = await runLessons(db, input({ params: dead, runId: "learn-2" }));
    expect(again.gradesWritten).toBe(0);
    // With wealth again the provisional row is superseded by the test result.
    const live = await runLessons(db, input({ runId: "learn-3" }));
    expect(live.testsWritten).toBeGreaterThan(0);
    const top = (
      await db.execute(
        `SELECT g.grade FROM lesson_grade g JOIN lesson l ON l.id = g.lesson_id
        WHERE l.template_id = 'LT-REGIME' AND g.seq = (SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = l.id)`,
      )
    ).rows;
    expect(top.map((t) => String(t.grade))).toEqual(["L2", "L2"]);
  });
});

describe("retire", () => {
  const gradeOf = async (db: Awaited<ReturnType<typeof freshDb>>, tpl: string) =>
    (
      await db.execute({
        sql: `SELECT l.id, g.grade, g.state_text, g.split_version FROM lesson l JOIN lesson_grade g ON g.lesson_id = l.id
        AND g.seq = (SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = l.id) WHERE l.template_id = ? ORDER BY l.id`,
        args: [tpl],
      })
    ).rows;

  it("(a) a retired rule version retires its lessons once and keeps the history", async () => {
    const db = await freshDb("main");
    await runLessons(db, input());
    const before = Number((await db.execute("SELECT COUNT(*) AS n FROM lesson_grade")).rows[0]!.n);
    const rep = await runLessons(
      db,
      input({ runId: "r2", retiredRuleVersions: new Set(["F1.v1"]) }),
    );
    expect(rep.retired).toBeGreaterThan(0);
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM lesson_grade")).rows[0]!.n)).toBe(
      before + rep.retired,
    );
    for (const g of await gradeOf(db, "LT-REGIME")) {
      expect(g.grade).toBe("retired");
      expect(String(g.state_text)).toBe("retired: rule version F1.v1 retired");
    }
    const rep2 = await runLessons(
      db,
      input({ runId: "r3", retiredRuleVersions: new Set(["F1.v1"]) }),
    );
    expect(rep2.retired).toBe(0);
    // A retired lesson stays retired even if the data would grade it again.
    const rep3 = await runLessons(db, input({ runId: "r4" }));
    expect(rep3.gradesWritten).toBe(0);
    expect(rep3.skippedRetired).toBeGreaterThan(0);
  });

  it("(b) a roll whose re-frozen L1 window no longer meets L1 retires the lesson", async () => {
    const db = await freshDb("main");
    await runLessons(db, input());
    const flat = DEV.flatMap((d, k) => [
      obs(`f${String(k)}a`, d, {
        regime: k % 2 === 0 ? "bull" : "bear",
        excess: Math.floor(k / 2) % 2 === 0 ? 0.01 : -0.01,
      }),
    ]);
    const rep = await runLessons(
      db,
      input({ rows: flat, runId: "roll", lineages: [lineage({ splitVersion: 2 })] }),
    );
    expect(rep.retired).toBeGreaterThanOrEqual(2);
    for (const g of await gradeOf(db, "LT-REGIME")) {
      expect(g.grade).toBe("retired");
      expect(Number(g.split_version)).toBe(2);
      expect(String(g.state_text)).toBe(
        "retired: re-frozen L1 window (split v2) no longer meets L1",
      );
    }
  });

  it("(c) a withdrawn template version retires its lessons", async () => {
    const db = await freshDb("main");
    await runLessons(db, input());
    const t = LESSON_TEMPLATES_V1.find((x) => x.id === "LT-REGIME")!;
    const rep = await runLessons(
      db,
      input({ runId: "w", withdrawnTemplates: new Set([templateKey(t)]) }),
    );
    expect(rep.retired).toBe(2);
    for (const g of await gradeOf(db, "LT-REGIME")) {
      expect(String(g.state_text)).toBe("retired: template LT-REGIME v1 withdrawn");
    }
    // Other templates are untouched.
    expect((await gradeOf(db, "LT-COST"))[0]!.grade).not.toBe("retired");
  });

  it("an L0 lesson is not retired by a roll that still observes it", async () => {
    const db = await freshDb("main");
    await runLessons(db, input({ lineages: [lineage({ block: 12 })] }));
    const rep = await runLessons(
      db,
      input({ runId: "roll", lineages: [lineage({ splitVersion: 2, block: 12 })] }),
    );
    expect(rep.retired).toBe(0);
  });
});

describe("grade wording (KB-020)", () => {
  const tpl = LESSON_TEMPLATES_V1.find((t) => t.id === "LT-REGIME")!;
  const base = {
    template: tpl,
    subject: { regime: "bull" },
    family: "F1",
    n: 40,
    estimate: 0.0123,
    lower: 0.004,
    upper: 0.02,
    p: 0.0123,
    alphaJ: 0.0476,
    intervalPct: 90,
    stateText: "",
  } as const;

  it("takes its verb from the grade, never stronger", () => {
    const text = (g: LessonGradeName) =>
      renderStatement({
        ...base,
        grade: g,
        stateText: g === "retired" ? "rule version retired" : "",
      });
    expect(text("L0")).toContain(GRADE_VERB.L0);
    expect(text("L0")).not.toMatch(/\bmay\b/);
    expect(text("L1")).toContain("may reflect a real effect");
    expect(text("L1")).toContain("90 % interval +0.40 % to +2.00 %");
    expect(text("L1")).not.toMatch(/\b(held|adopted)\b/);
    expect(text("L2")).toContain("held in a later test");
    expect(text("L2")).toContain("p = 0.0123");
    expect(text("L2")).not.toMatch(/\badopted\b/);
    expect(text("L3")).toContain("is adopted");
    expect(text("retired")).toContain("is retired (rule version retired)");
    expect(text("L0")).toContain("+1.23 %");
  });

  it("refuses a statement that carries a word reserved for a stronger grade", () => {
    const sneaky = { ...tpl, describe: () => "entries that were confirmed" };
    expect(() => renderStatement({ ...base, template: sneaky, grade: "L1" })).toThrow(
      /reserved for a stronger grade/,
    );
    expect(() =>
      renderStatement({ ...base, template: { ...tpl, describe: () => "may help" }, grade: "L0" }),
    ).toThrow(/stronger/);
  });

  it("every stored lesson renders at its stored grade through statementOf", async () => {
    const db = await freshDb("main");
    await runLessons(db, input({ lineages: [lineage()], retiredRuleVersions: new Set() }));
    const rows = (
      await db.execute(
        `SELECT l.template_id, l.subject_json, l.lineage_id, g.* FROM lesson l JOIN lesson_grade g ON g.lesson_id = l.id`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const text = statementOf(
        {
          template_id: String(r.template_id),
          subject_json: String(r.subject_json),
          lineage_id: r.lineage_id === null ? null : String(r.lineage_id),
        },
        {
          grade: String(r.grade) as LessonGradeName,
          n: Number(r.n),
          estimate: r.estimate === null ? null : Number(r.estimate),
          lower: r.lower === null ? null : Number(r.lower),
          upper: r.upper === null ? null : Number(r.upper),
          p: r.p === null ? null : Number(r.p),
          alpha_j: r.alpha_j === null ? null : Number(r.alpha_j),
          state_text: String(r.state_text),
        },
        params,
        "F1",
      );
      expect(text.length).toBeGreaterThan(10);
    }
  });
});
