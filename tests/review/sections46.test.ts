// @vitest-environment node
// Evening Review sections 4-6 from the stored A6 output (M6 T11; AT-20 content parts, EML-012, EML-037,
// D-104, D-123): lessons with grades, Lane-A changes, challenger status with the earliest date a
// promotion could first be possible, the plan and the review of yesterday's plan, findings or "no
// detectable difference (n = ...)", the partial rule (no `learn` run -> sections 4-6 missing) and the
// non-trading review that still has A6 content. The rows are produced by the real `learn` phase.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { learnDay } from "@/lib/learning/learnStage";
import { learnKey, wordsKey } from "@/lib/learning/learnFacts";
import { assembleReview, buildFacts } from "@/lib/review/assemble";
import { runKeys } from "@/lib/review/facts";
import { defaultAgentParams } from "@/lib/agents/params";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { cleanupTempDbs } from "../db/helpers";
import { addLineage, ownerChallenger } from "../learning/challengerFixtures";
import { addRun as addLearnRun, seedLesson } from "../learning/learnHelpers";
import { APP, D, MARKET, NOW, PREV, SAT, addMarker, exec, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

const PARAMS = defaultAgentParams();
const opts = (d = D) => ({ market: MARKET, d, env: "production" as const, appUrl: APP, now: NOW });
const nowFor = (d: string) => (): string => `${d}T08:50:00.000Z`;

it("the review's run keys are the phases' keys", () => {
  expect(runKeys.learn(MARKET, D)).toBe(learnKey(MARKET, D));
  expect(runKeys.words(MARKET, D)).toBe(wordsKey(MARKET, D));
});

const failRun = (db: Client, key: string, status = "failed") =>
  db.execute({
    sql: "UPDATE run_record SET status = ? WHERE concurrency_key = ?",
    args: [status, key],
  });

/** A world with the review fixtures plus a challenger, a lesson, comparison rows and a finding. */
async function a6World(): Promise<Client> {
  const db = await mainWorld();
  await tradingDay(db); // runs 2a, 2b, 3 and `learn` for D (the learn row is replaced below)
  await failRun(db, learnKey(MARKET, D));
  await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
  await addLineage(db, "F1");
  const made = await ownerChallenger(db, 0, "2026-10-14");
  if (made.status !== "created") throw new Error("challenger");
  for (const to of ["replay", "shakedown"] as const) {
    await transitionChallenger(
      db,
      { id: made.id, to, d: "2026-10-15", actor: "A6", reason: "t" },
      PARAMS.learning,
    );
  }
  await seedLesson(db, "L-1", "L2", { critic: true, d: D });
  // plan of Friday (one open data-quality flag), reviewed on Monday
  await db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at)
          VALUES (?, 'ZZ1', ?, 'dq-a', 'warn', '2026-10-15T08:00:00.000Z')`,
    args: [MARKET, PREV],
  });
  await addLearnRun(db, `arena-2b:${MARKET}:${PREV}`, "arena-signals", PREV);
  await addLearnRun(db, `arena-3:${MARKET}:${PREV}`, "arena-review", PREV);
  await learnDay(db, { market: MARKET, d: PREV, now: nowFor(PREV), params: PARAMS });
  // comparison rows, a passed look and a finished attribution of D
  await db.execute({
    sql: `INSERT INTO comparison_result (market, kind, pair_id, d, n_a, n_b, estimate, lower, upper, p, bh_rank, discovery, block, B, label)
          VALUES (?, 'nightly', 'F1.v1|F2.v1', ?, 40, 41, 12.5, -30.0, 55.0, NULL, NULL, 0, 5, 1000, 'descriptive — not a finding'),
                 (?, 'nightly', 'F1.v1|F4.v1', ?, 40, 12, NULL, NULL, NULL, NULL, NULL, 0, 5, 0, 'not enough data (n = 12)'),
                 (?, 'look', 'F2.v1|F4.v1', ?, 60, 60, 80.0, 20.0, 140.0, 0.01, NULL, 0, 5, 1000, 'confirmation look — passed (finding)')`,
    args: [MARKET, D, MARKET, D, MARKET, D],
  });
  await db.execute({
    sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm, mae_ppm,
            hold_sessions, cost_micro, slippage_micro, net_micro, excess_ppm, stress_ppm)
          VALUES ('trade', 't-1', 1, ?, ?, 1, ?, 30, -10, 4, 1, 1, 100, NULL, 5)`,
    args: [MARKET, D, JSON.stringify({ exit: { reason: "stop", tag: "IS" }, entry_d: PREV })],
  });
  await learnDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS });
  return db;
}

describe("sections 4-6 from A6 output", () => {
  it("section 4 lists the lessons with grades, the Lane-A change and the challenger status with its date", async () => {
    const db = await a6World();
    const { facts, variant, missing, narrative } = await buildFacts(db, opts());
    expect(variant).toBe("full");
    expect(missing).toEqual([]);
    expect(narrative).toBe("rules");
    const s4 = facts.narrative!.s4.join("\n");
    expect(s4).toMatch(/Lesson L-1 \(L3, n = 120\)/); // adopted through Lane A tonight
    expect(s4).toMatch(/Playbook A1.* changes from 2026-10-20/);
    const ch = facts.narrative!.s4.find((l) => l.startsWith("Challenger C-"))!;
    expect(ch).toContain("is in shakedown");
    expect(ch).toMatch(
      /could reach review on 2026-\d\d-\d\d, then needs your approval and the next group restart/,
    );
    expect(s4).not.toMatch(/No attribution observations/);
  });

  it("section 5 states a finding with its numbers, or 'no detectable difference (n = ...)', and today's attributions", async () => {
    const db = await a6World();
    const s5 = (await buildFacts(db, opts())).facts.narrative!.s5.join("\n");
    expect(s5).toContain("F1.v1|F2.v1: no detectable difference (n = 40).");
    expect(s5).toContain(
      "F2.v1|F4.v1: confirmation look — passed (finding) (estimate 80, p = 0.01, n = 60).",
    );
    expect(s5).toContain("1 comparison: not enough data yet.");
    expect(s5).toContain("1 position finished and was attributed today (exits: stop 1).");
  });

  it("section 6 shows tonight's plan and the review of yesterday's plan", async () => {
    const db = await a6World();
    const s6 = (await buildFacts(db, opts())).facts.narrative!.s6;
    expect(s6.some((l) => /^Plan item 1 \(A\): playbook .* change/.test(l))).toBe(true);
    expect(s6.some((l) => /^Plan of 2026-10-16, item \d+ \(.*\): /.test(l))).toBe(true);
    // at most five plan items (ARN-066)
    expect(s6.filter((l) => l.startsWith("Plan item ")).length).toBeLessThanOrEqual(5);
  });

  it("the rendered review carries the A6 lines and says it was written without AI (rules lists)", async () => {
    const db = await a6World();
    const out = await assembleReview(db, opts());
    expect(out.text).toContain("Lesson L-1");
    expect(out.text).toContain("no detectable difference (n = 40)");
    expect(out.text).toContain("Written without AI today");
  });

  it("is bounded to D: A6 rows of the next night do not appear", async () => {
    const db = await a6World();
    await exec(
      db,
      `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
       VALUES (?, '2026-10-20', 1, 'data_weakness', 'no-lesson:data_weakness: later', NULL, 'ops', '{"metric":"m","threshold":0,"check_d":"2026-10-21","ref":{}}')`,
      [MARKET],
    );
    const s6 = (await buildFacts(db, opts())).facts.narrative!.s6.join("\n");
    expect(s6).not.toContain("later");
  });
});

describe("the partial rule (D-104, D-123)", () => {
  it("without a `learn` run sections 4-6 are missing and the review is partial; section 7 is not", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await failRun(db, learnKey(MARKET, D));
    const { variant, missing, facts } = await buildFacts(db, opts());
    expect(variant).toBe("partial");
    expect(missing.map((m) => m.n)).toEqual([4, 5, 6]);
    expect(facts.narrative).toBeNull();
  });

  it("a degraded `learn` run still feeds the sections, flagged as partial inputs", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await failRun(db, learnKey(MARKET, D), "degraded");
    const { variant, facts } = await buildFacts(db, opts());
    expect(variant).toBe("full");
    expect(facts.narrative!.s4[0]).toBe("Tonight's learning step ran on partial inputs.");
  });

  it("missing batch 3 leaves sections 4-6 alone and takes only section 7", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await failRun(db, runKeys.review(MARKET, D));
    const { missing } = await buildFacts(db, opts());
    expect(missing.map((m) => m.n)).toEqual([7]);
  });
});

describe("a non-trading review (D-110 #3)", () => {
  it("has A6 content from the reduced `learn` run of that day", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await addMarker(db, SAT, "non-trading");
    await seedLesson(db, "L-1", "L2", { critic: true, d: PREV });
    await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
    const r = await learnDay(db, { market: MARKET, d: SAT, now: nowFor(SAT), params: PARAMS });
    expect(r.stats.variant).toBe("reduced");
    const { facts, variant } = await buildFacts(db, opts(SAT));
    expect(variant).toBe("nonTrading");
    const s4 = facts.narrative!.s4.join("\n");
    expect(s4).toMatch(/Playbook A1.* changes from 2026-10-19/); // effective on Monday
    expect(s4).toContain("Lesson L-1");
    expect(facts.narrative!.s5.join("\n")).toContain("No position finished today");
    expect(facts.narrative!.s6.join("\n")).toMatch(/Plan item 1/);
  });

  it("without a reduced run the non-trading review is still complete (never partial)", async () => {
    const db = await mainWorld();
    await tradingDay(db);
    await addMarker(db, SAT, "non-trading");
    const { variant, missing, facts } = await buildFacts(db, opts(SAT));
    expect(variant).toBe("nonTrading");
    expect(missing).toEqual([]);
    expect(facts.narrative!.s4.join(" ")).toMatch(/No attribution observations/);
  });
});
