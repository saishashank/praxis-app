// @vitest-environment node
// AT-20 sections 4-6 (carried from M5 to M6 T18; EML-012, EML-037, EML-015, D-104, D-123). The Evening
// Review sections that hold A6 output: 4 lessons with grades, Lane-A changes and challenger status with
// "when promotion could first be possible"; 5 findings or "no detectable difference"; 6 the plan and
// the review of yesterday's plan. The rows come from the real `learn` phase; the review is assembled by
// the real facts and renderer. Heavier cover (named, not repeated): tests/review/sections46.test.ts.
// PENDING (Owner / staging, not evidenced here): the inbox check, and the real review on a staging run.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { learnKey } from "@/lib/learning/learnFacts";
import { learnDay } from "@/lib/learning/learnStage";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { assembleReview, buildFacts } from "@/lib/review/assemble";
import { cleanupTempDbs } from "../../db/helpers";
import { addLineage, ownerChallenger } from "../../learning/challengerFixtures";
import { addRun, seedLesson } from "../../learning/learnHelpers";
import { APP, D, MARKET, NOW, PREV, mainWorld, tradingDay } from "../../review/helpers";

const PARAMS = defaultAgentParams();
const opts = { market: MARKET, d: D, env: "production" as const, appUrl: APP, now: NOW };
const nowFor = (d: string) => (): string => `${d}T08:50:00.000Z`;

let db: Client;
beforeAll(async () => {
  db = await mainWorld();
  await tradingDay(db); // runs 2a, 2b, 3 and `learn` for D; the learn row is replaced below
  await db.execute({
    sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ?",
    args: [learnKey(MARKET, D)],
  });
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
  // Friday's plan (one open data-quality flag), reviewed on Monday
  await db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at)
          VALUES (?, 'ZZ1', ?, 'dq-a', 'warn', '2026-10-15T08:00:00.000Z')`,
    args: [MARKET, PREV],
  });
  await addRun(db, `arena-2b:${MARKET}:${PREV}`, "arena-signals", PREV);
  await addRun(db, `arena-3:${MARKET}:${PREV}`, "arena-review", PREV);
  await learnDay(db, { market: MARKET, d: PREV, now: nowFor(PREV), params: PARAMS });
  await db.execute({
    sql: `INSERT INTO comparison_result (market, kind, pair_id, d, n_a, n_b, estimate, lower, upper, p, bh_rank, discovery, block, B, label)
          VALUES (?, 'nightly', 'F1.v1|F2.v1', ?, 40, 41, 12.5, -30.0, 55.0, NULL, NULL, 0, 5, 1000, 'descriptive — not a finding'),
                 (?, 'look', 'F2.v1|F4.v1', ?, 60, 60, 80.0, 20.0, 140.0, 0.01, NULL, 0, 5, 1000, 'confirmation look — passed (finding)')`,
    args: [MARKET, D, MARKET, D],
  });
  await learnDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS });
});
afterAll(cleanupTempDbs);

describe("AT-20 sections 4-6 from the stored A6 output", () => {
  it("section 4: the lesson with its grade, the Lane-A change, the challenger status and the earliest date a promotion could first be possible", async () => {
    const { facts, variant, missing, narrative } = await buildFacts(db, opts);
    expect(variant).toBe("full");
    expect(missing).toEqual([]);
    expect(narrative).toBe("rules");
    const s4 = facts.narrative!.s4;
    expect(s4.join("\n")).toMatch(/Lesson L-1 \(L3, n = 120\)/);
    expect(s4.join("\n")).toMatch(/Playbook A1.* changes from 2026-10-20/);
    const ch = s4.find((l) => l.startsWith("Challenger C-"))!;
    expect(ch).toContain("is in shakedown");
    expect(ch).toMatch(
      /could reach review on 2026-\d\d-\d\d, then needs your approval and the next group restart/,
    );
  });

  it("section 5: a finding states its numbers, otherwise 'no detectable difference (n = ...)'", async () => {
    const s5 = (await buildFacts(db, opts)).facts.narrative!.s5.join("\n");
    expect(s5).toContain("F1.v1|F2.v1: no detectable difference (n = 40).");
    expect(s5).toContain(
      "F2.v1|F4.v1: confirmation look — passed (finding) (estimate 80, p = 0.01, n = 60).",
    );
  });

  it("section 6: tonight's plan (at most 5 items) and the review of the previous plan", async () => {
    const s6 = (await buildFacts(db, opts)).facts.narrative!.s6;
    const items = s6.filter((l) => l.startsWith("Plan item "));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(s6.some((l) => /^Plan of 2026-10-16, item \d+ \(.*\): /.test(l))).toBe(true);
  });

  it("the rendered review carries the A6 lines, and without a `learn` run sections 4-6 are marked missing", async () => {
    const out = await assembleReview(db, opts);
    expect(out.text).toContain("Lesson L-1");
    expect(out.text).toContain("no detectable difference (n = 40)");
    expect(out.text).toContain("Written without AI today");
    // the partial rule (AGT-050): no finished `learn` run -> sections 4-6 are missing, the review is partial
    await db.execute({
      sql: "UPDATE run_record SET status = 'failed' WHERE concurrency_key = ?",
      args: [learnKey(MARKET, D)],
    });
    const partial = await buildFacts(db, opts);
    expect(partial.variant).toBe("partial");
    expect(partial.missing.map((m) => m.n)).toEqual([4, 5, 6]);
  });
});
