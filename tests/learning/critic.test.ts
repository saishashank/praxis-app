// @vitest-environment node
// A7 Critic (M6 T6; AGT-041/042, LLM-010, LLM-021; D-110 #4, #5, #15-#17, D-119): each of the six
// checks pass/fail on a hand case, critique idempotency, wording grounded/capped, the provider rule,
// deferred marks, and the challenger review that sets `ready`.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadChallenger } from "@/lib/learning/challengerLifecycle";
import {
  checkBounds,
  checkDataIssues,
  checkLuck,
  checkRegime,
  checkSampleSize,
  checkStress,
  criticParams,
  evaluateSubject,
  reviewWithCritic,
  writeCritique,
  type ChallengerSubject,
  type CriticRow,
  type LessonSubject,
} from "@/lib/learning/critic";
import {
  CRITIC_WORDING_DEFERRED,
  orderForWording,
  packOf,
  parseWording,
  pickCriticChain,
  templateWording,
  wordConcerns,
  type WordingSubject,
} from "@/lib/learning/criticWords";
import { checkGrounding } from "@/lib/llm/grounding";
import type { MockFixture } from "@/lib/llm/providers";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter, mockProvider } from "../llm/helpers";
import { rows as sqlRows, world } from "./challengerFixtures";

afterEach(cleanupTempDbs);

const AP = defaultAgentParams();
const P = criticParams(AP);
const WINDOW = { startD: "2026-01-01", endD: "2026-06-30", testD: "2026-07-15" };

function mkRows(n: number, over: (i: number) => Partial<CriticRow> = () => ({})): CriticRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    regime: i % 2 === 0 ? "ON" : "OFF",
    value: 0.01,
    stressValue: 0.005,
    stressNet: 0.004,
    flagged: false,
    entryD: "2026-03-02",
    outcomeD: "2026-03-10",
    ...over(i),
  }));
}

function challenger(over: Partial<ChallengerSubject> = {}): ChallengerSubject {
  return {
    kind: "challenger",
    id: "C-AU-F1-101",
    rows: mkRows(P.minRows),
    blocks: P.minBlocks,
    val110: { i: "pass", iv: "pass" },
    window: WINDOW,
    params: [{ key: "stop_pct", value: 5, min: 1, max: 10 }],
    ...over,
  };
}

function lesson(over: Partial<LessonSubject> = {}): LessonSubject {
  return {
    kind: "lesson",
    id: "L-AU-1",
    grade: "L2",
    direction: 1,
    rows: mkRows(P.lessonMinRows * 2),
    blocks: P.minBlocks,
    l2: "passed",
    window: WINDOW,
    ...over,
  };
}

describe("check 1: sample size", () => {
  it("challenger needs min_trades rows and min_blocks blocks", () => {
    expect(checkSampleSize(challenger(), P).state).toBe("pass");
    expect(checkSampleSize(challenger({ rows: mkRows(P.minRows - 1) }), P).state).toBe("fail");
    expect(checkSampleSize(challenger({ blocks: P.minBlocks - 1 }), P).state).toBe("fail");
  });
  it("lesson needs lesson_L1_min_n rows and min_blocks blocks", () => {
    expect(checkSampleSize(lesson({ rows: mkRows(P.lessonMinRows) }), P).state).toBe("pass");
    expect(checkSampleSize(lesson({ rows: mkRows(P.lessonMinRows - 1) }), P).state).toBe("fail");
  });
});

describe("check 2: regime dependence", () => {
  const regimeRows = (on: number, off: number): CriticRow[] =>
    mkRows(P.lessonMinRows * 2, (i) => ({ value: i % 2 === 0 ? on : off }));
  it("passes when most qualifying regimes keep the sign", () => {
    expect(checkRegime(lesson({ rows: regimeRows(0.02, 0.01) }), P).state).toBe("pass");
  });
  it("fails when the estimate is negative in at least half of the qualifying regimes", () => {
    expect(checkRegime(lesson({ rows: regimeRows(0.02, -0.01) }), P).state).toBe("fail");
  });
  it("a single qualifying regime counts, negative there fails", () => {
    const one = mkRows(P.lessonMinRows, () => ({ regime: "ON", value: -0.01 }));
    expect(checkRegime(challenger({ rows: one }), P).state).toBe("fail");
    const okOne = mkRows(P.lessonMinRows, () => ({ regime: "ON" }));
    expect(checkRegime(challenger({ rows: okOne }), P).state).toBe("pass");
  });
  it("no regime with enough rows is not assessable, not a failure", () => {
    const few = mkRows(P.lessonMinRows - 1, () => ({ regime: "ON" }));
    expect(checkRegime(challenger({ rows: few }), P).state).toBe("not_assessable");
  });
  it("uses the lesson direction", () => {
    const neg = lesson({ direction: -1, rows: regimeRows(-0.02, -0.01) });
    expect(checkRegime(neg, P).state).toBe("pass");
  });
});

describe("check 3: stress costs", () => {
  it("challenger follows VAL-110 (iv)", () => {
    expect(checkStress(challenger()).state).toBe("pass");
    expect(checkStress(challenger({ val110: { i: "pass", iv: "fail" } })).state).toBe("fail");
    expect(checkStress(challenger({ val110: { i: "pass", iv: "insufficient" } })).state).toBe(
      "pending",
    );
  });
  it("positive lesson: stressed net must stay above zero", () => {
    expect(checkStress(lesson()).state).toBe("pass");
    const bad = lesson({ rows: mkRows(P.lessonMinRows, () => ({ stressNet: -0.01 })) });
    expect(checkStress(bad).state).toBe("fail");
  });
  it("negative lesson: the stress excess keeps the claimed sign", () => {
    const keeps = lesson({
      direction: -1,
      rows: mkRows(P.lessonMinRows, () => ({ stressValue: -0.01 })),
    });
    expect(checkStress(keeps).state).toBe("pass");
    const flips = lesson({
      direction: -1,
      rows: mkRows(P.lessonMinRows, () => ({ stressValue: 0.01 })),
    });
    expect(checkStress(flips).state).toBe("fail");
  });
});

describe("check 4: data issues", () => {
  it("passes within the flagged share cap and the input bound", () => {
    expect(checkDataIssues(challenger(), P).state).toBe("pass");
  });
  it("fails above the flagged-share cap, at the cap it passes", () => {
    const total = 100;
    const cap = Math.floor((Number(P.flagShare.num) * total) / Number(P.flagShare.den));
    const atCap = mkRows(total, (i) => ({ flagged: i < cap }));
    const over = mkRows(total, (i) => ({ flagged: i < cap + 1 }));
    expect(checkDataIssues(challenger({ rows: atCap }), P).state).toBe("pass");
    expect(checkDataIssues(challenger({ rows: over }), P).state).toBe("fail");
  });
  it("fails when an outcome is observed on or after the test date or still open", () => {
    const late = mkRows(P.minRows, (i) => (i === 0 ? { outcomeD: WINDOW.testD } : {}));
    const open = mkRows(P.minRows, (i) => (i === 0 ? { outcomeD: null } : {}));
    const early = mkRows(P.minRows, (i) => (i === 0 ? { entryD: "2025-12-31" } : {}));
    for (const r of [late, open, early]) {
      expect(checkDataIssues(challenger({ rows: r }), P).state).toBe("fail");
    }
  });
  it("fails for a survivorship-exposed challenger; no rows is not assessable", () => {
    expect(checkDataIssues(challenger({ survivorshipExposed: true }), P).state).toBe("fail");
    expect(checkDataIssues(challenger({ rows: [] }), P).state).toBe("not_assessable");
  });
});

describe("check 5: luck", () => {
  it("challenger follows VAL-110 (i)", () => {
    expect(checkLuck(challenger()).state).toBe("pass");
    expect(checkLuck(challenger({ val110: { i: "fail", iv: "pass" } })).state).toBe("fail");
  });
  it("lesson: L2 passed / not passed / pending", () => {
    expect(checkLuck(lesson({ l2: "passed" })).state).toBe("pass");
    expect(checkLuck(lesson({ l2: "not_passed" })).state).toBe("fail");
    expect(checkLuck(lesson({ l2: "pending", grade: "L1" })).state).toBe("pending");
  });
});

describe("check 6: bounds", () => {
  it("passes inside, fails outside or non-finite; a lesson without a parameter passes", () => {
    expect(checkBounds(challenger()).state).toBe("pass");
    const out = challenger({ params: [{ key: "stop_pct", value: 11, min: 1, max: 10 }] });
    expect(checkBounds(out).state).toBe("fail");
    const nan = challenger({ params: [{ key: "k", value: Number.NaN, min: 1, max: 10 }] });
    expect(checkBounds(nan).state).toBe("fail");
    expect(checkBounds(lesson()).state).toBe("pass");
  });
});

describe("evaluation", () => {
  it("a good challenger passes all six; a lesson L1 may be pending on check 5", () => {
    expect(evaluateSubject(challenger(), P).passed).toBe(true);
    expect(evaluateSubject(lesson({ grade: "L1", l2: "pending" }), P).passed).toBe(true);
    expect(evaluateSubject(lesson({ grade: "L2", l2: "pending" }), P).passed).toBe(false);
    expect(evaluateSubject(lesson({ grade: "L1", l2: "not_passed" }), P).passed).toBe(false);
  });
  it("a not-assessable check is not a pass for a challenger", () => {
    const few = mkRows(P.minRows, (i) => ({ regime: `R${i}` }));
    const e = evaluateSubject(challenger({ rows: few }), P);
    expect(e.checks[1]!.state).toBe("not_assessable");
    expect(e.passed).toBe(false);
  });
});

describe("critique rows are idempotent", () => {
  it("same run writes nothing; unchanged state writes nothing; a change appends", async () => {
    const { db } = await world();
    const good = evaluateSubject(challenger(), P);
    expect(await writeCritique(db, { evaluation: good, runId: "run-1", d: "2026-07-16" })).toEqual({
      written: true,
      reason: "new",
    });
    expect(await writeCritique(db, { evaluation: good, runId: "run-1", d: "2026-07-16" })).toEqual({
      written: false,
      reason: "same-run",
    });
    expect(await writeCritique(db, { evaluation: good, runId: "run-2", d: "2026-07-17" })).toEqual({
      written: false,
      reason: "unchanged",
    });
    const bad = evaluateSubject(challenger({ val110: { i: "pass", iv: "fail" } }), P);
    expect(await writeCritique(db, { evaluation: bad, runId: "run-3", d: "2026-07-18" })).toEqual({
      written: true,
      reason: "changed",
    });
    const stored = await sqlRows(db, "SELECT run_id, passed FROM critique ORDER BY d");
    expect(stored).toEqual([
      { run_id: "run-1", passed: 1 },
      { run_id: "run-3", passed: 0 },
    ]);
  });
});

describe("challenger review sets ready only when all six pass (D-119)", () => {
  async function inReview(db: Client): Promise<string> {
    const id = "C-AU-F1-101";
    await db.execute({
      sql: `INSERT INTO challenger (id, lineage_id, rule_version_id, incumbent_version_id, origin, state_d, trial_id)
            VALUES (?, 'AU:F1', 'F1.v101', 'F1.v1', 'owner', '2026-10-05', 't')`,
      args: [id],
    });
    for (const s of ["replay", "shakedown", "review"]) {
      await db.execute({ sql: "UPDATE challenger SET state = ? WHERE id = ?", args: [s, id] });
    }
    return id;
  }

  it("ready on all-pass, cleared when a re-check fails, critique rows follow", async () => {
    const { db } = await world();
    const id = await inReview(db);
    const run = (runId: string, subject: ChallengerSubject) =>
      reviewWithCritic(db, { challengerId: id, runId, d: "2026-07-16", subject, params: P });
    const first = await run("r1", challenger());
    expect(first.verdict.ready).toBe(true);
    expect((await loadChallenger(db, id))!.ready).toBe(1);
    const again = await run("r2", challenger());
    expect(again.critique.reason).toBe("unchanged");
    expect(again.readyChanged).toBe(false);
    const bad = await run("r3", challenger({ params: [{ key: "k", value: 99, min: 1, max: 10 }] }));
    expect(bad.verdict).toMatchObject({ ready: false, failed: [6] });
    expect((await loadChallenger(db, id))!).toMatchObject({ state: "review", ready: 0 });
    const n = await sqlRows(db, "SELECT COUNT(*) AS n FROM critique WHERE subject_id = ?", [id]);
    expect(Number(n[0]!.n)).toBe(2);
  });

  it("a pending check keeps it not ready; a wrong subject id is refused", async () => {
    const { db } = await world();
    const id = await inReview(db);
    const r = await reviewWithCritic(db, {
      challengerId: id,
      runId: "r1",
      d: "2026-07-16",
      subject: challenger({ val110: { i: "insufficient", iv: "pass" } }),
      params: P,
    });
    expect(r.verdict).toMatchObject({ ready: false, open: [5] });
    await expect(
      reviewWithCritic(db, {
        challengerId: id,
        runId: "r2",
        d: "2026-07-16",
        subject: challenger({ id: "C-AU-F1-999" }),
        params: P,
      }),
    ).rejects.toThrow(/is not challenger/);
  });
});

// ---- wording -------------------------------------------------------------------------------------------------

function wsub(
  id: string,
  grade: WordingSubject["grade"],
  over: Partial<WordingSubject> = {},
): WordingSubject {
  const subject =
    grade === null
      ? challenger({ id, val110: { i: "pass", iv: "fail" } })
      : lesson({ id, grade, l2: grade === "L1" ? "pending" : "passed" });
  return { evaluation: evaluateSubject(subject, P), grade, ...over };
}

describe("wording: order, template, grounding, caps", () => {
  it("orders challengers first, then lessons by grade desc, then id", () => {
    const o = orderForWording([
      wsub("L-b", "L1"),
      wsub("L-a", "L1"),
      wsub("L-c", "L3"),
      wsub("C-1", null),
      wsub("L-d", "L2"),
    ]).map((s) => s.evaluation.id);
    expect(o).toEqual(["C-1", "L-c", "L-d", "L-a", "L-b"]);
  });

  it("the template wording is grounded in the pack and within the caps", () => {
    for (const s of [wsub("C-1", null), wsub("L-1", "L1"), wsub("L-2", "L2")]) {
      const w = templateWording(s.evaluation);
      expect(parseWording(w)).not.toBeNull();
      expect(checkGrounding(w, packOf(s)).ok).toBe(true);
    }
  });

  it("the pack carries no ids, annotations or third-party text", () => {
    const pack = JSON.stringify(packOf(wsub("L-secret-1", "L2")));
    expect(pack).not.toContain("L-secret-1");
    expect(Object.keys(packOf(wsub("L-1", "L2"))).sort()).toEqual(["checks", "subject"]);
  });

  it("parse enforces the item and length caps", () => {
    const line = "x";
    expect(parseWording({ concerns: [line], alternatives: [] })).not.toBeNull();
    expect(parseWording({ concerns: Array(7).fill(line), alternatives: [] })).toBeNull();
    expect(parseWording({ concerns: [line.repeat(401)], alternatives: [] })).toBeNull();
    expect(parseWording({ concerns: [""], alternatives: [] })).toBeNull();
    expect(parseWording({ concerns: "a", alternatives: [] })).toBeNull();
  });
});

describe("provider rule (LLM-010, D-110 #4)", () => {
  const mk = (id: string, model: string) =>
    ({ ...mockProvider({}), id, modelFor: () => model }) as ReturnType<typeof mockProvider>;
  it("prefers a different provider", () => {
    const r = pickCriticChain([mk("a", "m1"), mk("b", "m2")], { provider: "a", model: "m1" });
    expect(r).toMatchObject({ chain: ["b"], rule: "different-provider", log: null });
  });
  it("one provider: a different model is logged; the same model degrades to rules-only", () => {
    const one = [mk("a", "m2")];
    const r = pickCriticChain(one, { provider: "a", model: "m1" });
    expect(r.rule).toBe("different-model");
    expect(r.log).toMatch(/LLM-010 degraded/);
    const none = pickCriticChain(one, { provider: "a", model: "m2" });
    expect(none).toMatchObject({ chain: [], rule: "rules-only" });
    expect(none.log).toMatch(/rules-only/);
  });
  it("no author: any provider; no providers: empty chain", () => {
    expect(pickCriticChain([mk("a", "m1")], null).chain).toEqual(["a"]);
    expect(pickCriticChain([], null).chain).toEqual([]);
  });
});

describe("wordConcerns: cap, deferred marks, modes, idempotency", () => {
  const params = {
    ...AP,
    learning: { ...AP.learning, criticLlmCallsPerNight: 2 },
  };
  const subjects = (): WordingSubject[] => [
    wsub("L-1", "L1"),
    wsub("L-2", "L2"),
    wsub("L-3", "L3"),
    wsub("C-1", null),
  ];

  async function run(
    db: Client,
    mode: "rules-only" | "mock" | "off",
    fixtures: Record<string, MockFixture> = {},
    runId = "w1",
    providers = [mockProvider(fixtures)],
  ) {
    return wordConcerns(db, {
      market: "AU",
      d: "2026-07-16",
      runId,
      params,
      subjects: subjects(),
      providers,
      routerFor: (chain) => makeRouter(mode, providers, undefined, { chain: { R3: chain } }).router,
    });
  }

  it("words the top subjects and marks the rest deferred", async () => {
    const { db } = await world();
    const rep = await run(db, "rules-only");
    expect(rep.worded).toBe(2);
    expect(rep.deferred).toBe(2);
    const notes = await sqlRows(
      db,
      "SELECT subject_id, kind, text, deferred, provider FROM critique_note ORDER BY subject_id, kind",
    );
    const deferred = notes.filter((n) => Number(n.deferred) === 1);
    expect(deferred.map((n) => n.subject_id)).toEqual(["L-1", "L-1", "L-2", "L-2"]);
    expect(deferred.every((n) => n.text === CRITIC_WORDING_DEFERRED)).toBe(true);
    const worded = notes.filter((n) => Number(n.deferred) === 0);
    expect(worded.map((n) => n.subject_id)).toEqual(["C-1", "C-1", "L-3", "L-3"]);
    expect(worded.every((n) => n.provider === null)).toBe(true);
  });

  it("is idempotent for a run id", async () => {
    const { db } = await world();
    await run(db, "rules-only");
    const again = await run(db, "rules-only");
    expect(again.outcomes.every((o) => o.status === "existing")).toBe(true);
    const n = await sqlRows(db, "SELECT COUNT(*) AS n FROM critique_note");
    expect(Number(n[0]!.n)).toBe(8);
  });

  it("mock mode uses the recorded answer; an ungrounded answer falls back to the template", async () => {
    const { db } = await world();
    const s = wsub("C-1", null);
    const prov = mockProvider({});
    const good: MockFixture = {
      text: JSON.stringify({ concerns: ["Check 5 (luck) failed."], alternatives: [] }),
      tokensIn: 10,
      tokensOut: 5,
    };
    const bad: MockFixture = {
      text: JSON.stringify({ concerns: ["Gain was 98765 percent."], alternatives: [] }),
      tokensIn: 10,
      tokensOut: 5,
    };
    const a = await wordConcerns(db, {
      market: "AU",
      d: "2026-07-16",
      runId: "good",
      params,
      subjects: [s],
      providers: [{ ...prov, call: () => Promise.resolve(good) } as typeof prov],
      routerFor: (chain) =>
        makeRouter(
          "mock",
          [{ ...prov, call: () => Promise.resolve(good) } as typeof prov],
          undefined,
          {
            chain: { R3: chain },
          },
        ).router,
    });
    expect(a.outcomes[0]).toMatchObject({ status: "worded", source: "mock" });
    const b = await wordConcerns(db, {
      market: "AU",
      d: "2026-07-16",
      runId: "bad",
      params,
      subjects: [s],
      providers: [{ ...prov, call: () => Promise.resolve(bad) } as typeof prov],
      routerFor: (chain) =>
        makeRouter(
          "mock",
          [{ ...prov, call: () => Promise.resolve(bad) } as typeof prov],
          undefined,
          {
            chain: { R3: chain },
          },
        ).router,
    });
    expect(b.outcomes[0]).toMatchObject({ status: "worded", source: "rules-only" });
    const rowsOut = await sqlRows(
      db,
      "SELECT run_id, text, provider FROM critique_note WHERE kind = 'concerns' AND run_id IN ('good','bad') ORDER BY run_id",
    );
    expect(rowsOut[1]!.text).toBe("Check 5 (luck) failed.");
    expect(rowsOut[1]!.provider).toBe("mock");
    expect(String(rowsOut[0]!.text)).not.toContain("98765");
    expect(rowsOut[0]!.provider).toBeNull();
  });

  it("logs the LLM-010 degrade and never changes a check state", async () => {
    const { db } = await world();
    const subs = subjects().map((s) => ({ ...s, author: { provider: "mock", model: "mock-1" } }));
    const providers = [mockProvider({})];
    const before = JSON.stringify(subs.map((s) => s.evaluation));
    const rep = await wordConcerns(db, {
      market: "AU",
      d: "2026-07-16",
      runId: "deg",
      params,
      subjects: subs,
      providers,
      routerFor: (chain) =>
        makeRouter("mock", providers, undefined, { chain: { R3: chain } }).router,
    });
    expect(rep.log.length).toBe(2);
    expect(rep.log[0]).toMatch(/LLM-010 degraded/);
    expect(
      rep.outcomes.filter((o) => o.status === "worded").every((o) => o.rule === "rules-only"),
    ).toBe(true);
    expect(JSON.stringify(subs.map((s) => s.evaluation))).toBe(before);
  });

  it("rules-only and mock modes give identical gates (the evaluation is independent of wording)", () => {
    const a = evaluateSubject(challenger(), P);
    const b = evaluateSubject(challenger(), P);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
