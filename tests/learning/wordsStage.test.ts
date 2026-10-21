// @vitest-environment node
// The `words` phase (M6 T11; LLM-010/021/031/050, ARN-068, AGT-041/042, KB-060; design 4.1 and 4.3;
// D-110 #4 #5 #48; D-120): preconditions and the partial rule, the Critic subjects it words, the cap and
// the deferred marks, the R5 narrative moved after `learn`, the budget reservation, idempotent reruns.
// Rules-only and mock routers only: no live provider.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRITIC_WORDING_DEFERRED } from "@/lib/learning/criticWords";
import {
  narrativeReserve,
  reservingRouter,
  subjectsToWord,
  wordsDay,
  wordsKey,
  type WordsLlm,
  type WordsOptions,
} from "@/lib/learning/wordsStage";
import { createMockProvider, promptSha, type LlmProvider } from "@/lib/llm/providers";
import { buildPrompt, type LlmRouter } from "@/lib/llm/router";
import { MemoryStore } from "@/lib/llm/store";
import { estimateTokens } from "@/lib/llm/budget";
import {
  NARRATIVE_TEMPLATE_VERSION,
  loadCtx,
  narrativeRequest,
  readNarrativePack,
  readNarrativeRow,
} from "@/lib/review/sections";
import { cleanupTempDbs } from "../db/helpers";
import { MOCK_MODEL, makeRouter } from "../llm/helpers";
import {
  D,
  MARKET,
  PARAMS,
  SAT,
  addCritique,
  addNight,
  addRun,
  challengerChecks,
  dumpLearning,
  lightWorld,
  nowFor,
  rows,
  seedLesson,
  shakedownChallenger,
} from "./learnHelpers";

afterEach(cleanupTempDbs);

type Mode = "rules-only" | "mock";

function llmFor(mode: Mode, providers: LlmProvider[] = [], store = new MemoryStore()): WordsLlm {
  return {
    r5Router: makeRouter(mode, providers, store, { chain: { R5: providers.map((p) => p.id) } })
      .router,
    providers,
    routerFor: (chain) => makeRouter(mode, providers, store, { chain: { R3: chain } }).router,
    store,
  };
}

const words = (db: Client, llm: WordsLlm, d = D, over: Partial<WordsOptions> = {}) =>
  wordsDay(db, { market: MARKET, d, now: nowFor(d), params: PARAMS, llm: () => llm, ...over });

/** A night where `learn` ran, with a challenger in review and two lessons that have Critic results. */
async function worldWithSubjects(d = D): Promise<Client> {
  const db = await lightWorld();
  await addNight(db, d);
  await addRun(db, `arena-learn:${MARKET}:${d}`, "arena-learn", d);
  const id = await shakedownChallenger(db, 0, "2026-10-06");
  await db.execute({
    sql: "UPDATE challenger SET state = 'review', state_d = ? WHERE id = ?",
    args: ["2026-10-14", id],
  });
  await addCritique(db, "challenger", id, challengerChecks(), true, d);
  await seedLesson(db, "L-1", "L2", {
    critic: true,
    checks: challengerChecks(0, 120, { 5: "pending" }),
    d,
  });
  await seedLesson(db, "L-2", "L1", {
    critic: false,
    checks: challengerChecks(0, 120, { 2: "fail" }),
    d,
  });
  return db;
}

describe("preconditions", () => {
  it("data-only mode records a skipped run and writes nothing", async () => {
    const db = await lightWorld("data_only");
    const before = await dumpLearning(db);
    expect(await words(db, llmFor("rules-only"))).toMatchObject({
      status: "skipped",
      reason: "data_only_guard",
    });
    expect(await dumpLearning(db)).toBe(before);
  });

  it("the routers are built only after the guards (a skipped run never touches them)", async () => {
    const db = await lightWorld("data_only");
    const llm = vi.fn(() => llmFor("rules-only"));
    await wordsDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS, llm });
    expect(llm).not.toHaveBeenCalled();
  });

  it("without a `learn` run of D the output is partial: degraded, still worded (AGT-050)", async () => {
    const db = await lightWorld();
    await addNight(db, D);
    const r = await words(db, llmFor("rules-only"));
    expect(r).toMatchObject({ status: "degraded", reason: "learn_missing" });
    expect(r.stats.narrative).toBe("rules");
  });

  it("with `learn` done the run succeeds and a rerun is a no-op", async () => {
    const db = await worldWithSubjects();
    const r = await words(db, llmFor("rules-only"));
    expect(r).toMatchObject({ status: "success", reason: null });
    const before = await dumpLearning(db);
    expect((await words(db, llmFor("rules-only"))).status).toBe("already_done");
    expect(await dumpLearning(db)).toBe(before);
  });
});

describe("A7 concerns", () => {
  it("words the subjects that need it, challengers first, under the run key", async () => {
    const db = await worldWithSubjects();
    const r = await words(db, llmFor("rules-only"));
    expect(r.stats.subjects).toBe(3);
    expect(r.stats.worded).toBe(3);
    expect(r.stats.deferred).toBe(0);
    const notes = await rows(
      db,
      "SELECT subject_kind, subject_id, run_id, kind, provider, fallback_depth, deferred FROM critique_note ORDER BY subject_kind, subject_id, kind",
    );
    expect(notes).toHaveLength(6);
    expect(notes.every((n) => n.run_id === wordsKey(MARKET, D))).toBe(true);
    expect(notes.every((n) => n.provider === null && n.fallback_depth === "rules-only")).toBe(true);
    const lesson2 = await rows(
      db,
      "SELECT text FROM critique_note WHERE subject_id = 'L-2' AND kind = 'concerns'",
    );
    expect(String(lesson2[0]!.text)).toContain("Check 2");
    // the deterministic gates are untouched by the wording (AGT-042)
    expect(await rows(db, "SELECT COUNT(*) AS n FROM critique")).toEqual([{ n: 3 }]);
  });

  it("at most `critic_llm_calls_per_night` subjects are worded, the rest are marked deferred (D-110 #5)", async () => {
    const db = await worldWithSubjects();
    const params = { ...PARAMS, learning: { ...PARAMS.learning, criticLlmCallsPerNight: 1 } };
    const r = await words(db, llmFor("rules-only"), D, { params });
    expect(r.stats.worded).toBe(1);
    expect(r.stats.deferred).toBe(2);
    const deferred = await rows(
      db,
      "SELECT DISTINCT text, deferred FROM critique_note WHERE deferred = 1",
    );
    expect(deferred).toEqual([{ text: CRITIC_WORDING_DEFERRED, deferred: 1 }]);
    // challengers first: the one worded subject is the challenger
    const worded = await rows(
      db,
      "SELECT DISTINCT subject_kind AS k FROM critique_note WHERE deferred = 0",
    );
    expect(worded).toEqual([{ k: "challenger" }]);
  });

  it("a subject whose latest Critic result is unchanged and already worded is not worded again", async () => {
    const db = await worldWithSubjects("2026-10-19");
    await words(db, llmFor("rules-only"), "2026-10-19");
    await addNight(db, D);
    await addRun(db, `arena-learn:${MARKET}:${D}`, "arena-learn", D);
    const subjects = await subjectsToWord(db, MARKET, D);
    expect(subjects).toEqual([]);
    // a new critique row on D makes the subject due again
    await addCritique(
      db,
      "lesson",
      "L-2",
      challengerChecks(0, 120, { 2: "pass" }),
      true,
      D,
      "crit-2",
    );
    const due = await subjectsToWord(db, MARKET, D);
    expect(due.map((s) => s.evaluation.id)).toEqual(["L-2"]);
    expect(due[0]!.grade).toBe("L1");
  });

  it("retired lessons and finished challengers are not worded; L0 never has a Critic result", async () => {
    const db = await worldWithSubjects();
    await db.execute({
      sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, B, state_text, run_id, d)
            VALUES ('L-2', 2, 'retired', 1, NULL, 0, 0, 0, '', 'r', ?)`,
      args: [D],
    });
    await db.execute("UPDATE challenger SET state = 'rejected', ready = 0");
    const subjects = await subjectsToWord(db, MARKET, D);
    expect(subjects.map((s) => s.evaluation.id)).toEqual(["L-1"]);
  });

  it("is bounded by D: a critique written after D is not seen", async () => {
    const db = await worldWithSubjects("2026-10-19");
    await addCritique(
      db,
      "lesson",
      "L-1",
      challengerChecks(0, 120, { 5: "fail" }),
      false,
      "2026-10-25",
      "later",
    );
    const subjects = await subjectsToWord(db, MARKET, "2026-10-19");
    const l1 = subjects.find((s) => s.evaluation.id === "L-1")!;
    expect(l1.evaluation.passed).toBe(true);
    expect(l1.evaluation.checks[4]!.state).toBe("pending");
  });
});

describe("R5 narrative after learn (design 4.1)", () => {
  async function fixtureLlm(db: Client, answer: unknown): Promise<WordsLlm> {
    const c = await loadCtx(db, {
      market: MARKET,
      d: D,
      env: "production",
      appUrl: "",
      now: new Date(`${D}T08:50:00.000Z`),
    });
    const req = narrativeRequest(MARKET, await readNarrativePack(c), false);
    const sha = promptSha(
      "R5",
      MOCK_MODEL,
      NARRATIVE_TEMPLATE_VERSION,
      buildPrompt(req.task, req.facts, [], false),
    );
    const provider = createMockProvider({
      model: MOCK_MODEL,
      roles: ["R5"],
      fixtures: { [sha]: { text: JSON.stringify(answer), tokensIn: 100, tokensOut: 40 } },
    });
    return llmFor("mock", [provider]);
  }

  it("the pack read by R5 holds the A6 output (the narrative runs after learn)", async () => {
    const db = await worldWithSubjects();
    await seedLesson(db, "L-3", "L1", { critic: true, d: D });
    const c = await loadCtx(db, {
      market: MARKET,
      d: D,
      env: "production",
      appUrl: "",
      now: new Date(`${D}T08:50:00.000Z`),
    });
    const pack = await readNarrativePack(c);
    expect(pack.learning).not.toBeNull();
    expect(pack.learning!.lessons.map((l) => l.id)).toContain("L-3");
  });

  it("a grounded mock answer is stored under the words run and used", async () => {
    const db = await worldWithSubjects();
    const answer = {
      s4: ["Lesson L-1 was graded."],
      s5: ["No comparison was conclusive."],
      s6: ["Nothing to add."],
    };
    const r = await words(db, await fixtureLlm(db, answer));
    expect(r.stats.narrative).toBe("llm");
    expect(await readNarrativeRow(db, MARKET, D)).toMatchObject({
      kind: "llm",
      provider: "mock",
      ...answer,
    });
    const stored = await rows(db, "SELECT run_id FROM replay_stat WHERE metric = 'narrative'");
    expect(stored).toEqual([{ run_id: wordsKey(MARKET, D) }]);
  });

  it("an ungrounded answer falls back to the facts-only lists", async () => {
    const db = await worldWithSubjects();
    const r = await words(
      db,
      await fixtureLlm(db, { s4: ["Gains of 987654 dollars."], s5: ["x"], s6: ["y"] }),
    );
    expect(r.stats.narrative).toBe("rules");
    expect((await readNarrativeRow(db, MARKET, D))?.kind).toBe("rules");
  });

  it("batch 3 no longer writes a narrative row (the R5 call moved to words)", async () => {
    const db = await worldWithSubjects();
    expect(
      await rows(db, "SELECT COUNT(*) AS n FROM replay_stat WHERE metric = 'narrative'"),
    ).toEqual([{ n: 0 }]);
  });

  it("on a non-trading day only the concerns are worded", async () => {
    const db = await worldWithSubjects();
    await addRun(db, `arena-learn:${MARKET}:${SAT}`, "arena-learn", SAT);
    const r = await words(db, llmFor("rules-only"), SAT);
    expect(r.status).toBe("success");
    expect(r.stats.narrative).toBeNull();
    expect(r.stats.reservedTokens).toBe(0);
  });
});

describe("the R5 reservation (D-110 #48, LLM-050 s13)", () => {
  const req = {
    role: "R3" as const,
    market: MARKET,
    d: D,
    nightly: true,
    templateVersion: "t",
    task: "word the concerns",
    facts: { a: 1 },
    parse: (v: unknown) => v,
    rules: { rules: true } as unknown,
    maxOutputTokens: 400,
  };
  const projected =
    estimateTokens(buildPrompt(req.task, req.facts, undefined, false)) + req.maxOutputTokens;
  const base = (route: ReturnType<typeof vi.fn>): LlmRouter =>
    ({ mode: "mock", route }) as unknown as LlmRouter;
  const ok = { value: { ok: true }, source: "mock", llmUsed: true };

  it("an R3 call that fits only by eating the reservation is answered rules-only, not sent", async () => {
    const reserve = 700;
    const params = {
      ...PARAMS,
      llm: { ...PARAMS.llm, nightlyTokensPerMarket: projected + reserve - 1 },
    };
    const route = vi.fn(async () => ok);
    let blocked = 0;
    const router = reservingRouter(base(route as never), {
      reserve,
      params,
      store: new MemoryStore(),
      onBlocked: () => {
        blocked += 1;
      },
    });
    const res = await router.route(req as never);
    expect(route).not.toHaveBeenCalled();
    expect(res).toMatchObject({ source: "rules-only", llmUsed: false, budgetExhausted: true });
    expect(res.value).toEqual({ rules: true });
    expect(blocked).toBe(1);
  });

  it("the same call goes through when the cap leaves room for both", async () => {
    const reserve = 700;
    const params = {
      ...PARAMS,
      llm: { ...PARAMS.llm, nightlyTokensPerMarket: projected + reserve },
    };
    const route = vi.fn(async () => ok);
    const router = reservingRouter(base(route as never), {
      reserve,
      params,
      store: new MemoryStore(),
      onBlocked: () => undefined,
    });
    await router.route(req as never);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("counts tokens already spent tonight, and leaves other roles and non-token modes alone", async () => {
    const reserve = 700;
    const store = new MemoryStore();
    await store.recordCall({
      id: "x",
      role: "R1",
      provider: "mock",
      modelId: "m",
      fallbackDepth: "0",
      tokensIn: 100,
      tokensOut: 0,
      cached: 0,
      outcome: "ok",
      injectionFiltered: 0,
      market: MARKET,
      d: D,
    });
    const params = {
      ...PARAMS,
      llm: { ...PARAMS.llm, nightlyTokensPerMarket: projected + reserve + 99 },
    };
    const route = vi.fn(async () => ok);
    const router = reservingRouter(base(route as never), {
      reserve,
      params,
      store,
      onBlocked: () => undefined,
    });
    await router.route(req as never);
    expect(route).not.toHaveBeenCalled(); // 100 spent: 99 short
    await router.route({ ...req, role: "R5" } as never);
    expect(route).toHaveBeenCalledTimes(1); // R5 itself is never held back
    const rulesOnly = { mode: "rules-only", route } as unknown as LlmRouter;
    const same = reservingRouter(rulesOnly, { reserve, params, store, onBlocked: () => undefined });
    await same.route(req as never);
    expect(route).toHaveBeenCalledTimes(2); // no tokens in rules-only mode: no reservation
  });

  it("the phase reserves the narrative's maximum before the first R3 call and reports it", async () => {
    const db = await worldWithSubjects();
    const c = await loadCtx(db, {
      market: MARKET,
      d: D,
      env: "production",
      appUrl: "",
      now: new Date(`${D}T08:50:00.000Z`),
    });
    const want = narrativeReserve(narrativeRequest(MARKET, await readNarrativePack(c), false));
    expect(want).toBeGreaterThan(600); // the output cap alone is 600
    const tight = { ...PARAMS, llm: { ...PARAMS.llm, nightlyTokensPerMarket: want + 50 } };
    const provider = createMockProvider({ model: MOCK_MODEL, roles: ["R3", "R5"], fixtures: {} });
    const r = await words(db, llmFor("mock", [provider]), D, { params: tight });
    expect(r.stats.reservedTokens).toBe(want);
    expect(r.stats.reservedBlocks).toBe(3); // every subject's R3 call would have eaten the reserve
    const generous = await worldWithSubjects();
    const g = await words(generous, llmFor("mock", [provider]), D, {
      params: { ...PARAMS, llm: { ...PARAMS.llm, nightlyTokensPerMarket: want * 10 } },
    });
    expect(g.stats.reservedBlocks).toBe(0);
  });
});
