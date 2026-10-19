// @vitest-environment node
// Look-ahead of the A6 phases (M6 T11; TST-109 for the nightly orchestration, decision 38): every row
// dated after D is perturbed and the outputs of `learn` and `words` for D must not move. The weekly
// learning run and the full-job perturbation are T12 / T16; this covers the readers of the nightly
// stages (grades, critiques, flags, findings, challengers, comparisons and the Lane-A input).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { learnDay } from "@/lib/learning/learnStage";
import { readLearnFacts } from "@/lib/learning/learnFacts";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { wordsDay, type WordsLlm } from "@/lib/learning/wordsStage";
import { MemoryStore } from "@/lib/llm/store";
import { cleanupTempDbs } from "../db/helpers";
import { makeRouter } from "../llm/helpers";
import {
  D,
  MARKET,
  PARAMS,
  addCritique,
  addNight,
  addRun,
  challengerChecks,
  dumpLearning,
  lightWorld,
  nowFor,
  seedLesson,
  shakedownChallenger,
} from "./learnHelpers";

afterEach(cleanupTempDbs);

const llm = (): WordsLlm => {
  const store = new MemoryStore();
  return {
    r5Router: makeRouter("rules-only", [], store).router,
    providers: [],
    routerFor: () => makeRouter("rules-only", [], store).router,
    store,
  };
};

async function baseWorld(): Promise<Client> {
  const db = await lightWorld();
  await addNight(db, "2026-10-19");
  await addNight(db, D);
  await seedLesson(db, "L-1", "L2", { critic: true });
  await seedLesson(db, "L-2", "L1", { critic: true, reachableD: "2026-10-21" });
  const id = await shakedownChallenger(db, 0, "2026-10-06");
  await db.execute({
    sql: "UPDATE challenger SET state = 'review', state_d = ? WHERE id = ?",
    args: ["2026-10-14", id],
  });
  await addCritique(db, "challenger", id, challengerChecks(), true, "2026-10-14");
  await db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at)
          VALUES (?, 'ZZ1', '2026-10-19', 'dq-a', 'warn', '2026-10-19T08:00:00.000Z')`,
    args: [MARKET],
  });
  return db;
}

/** Rows that only exist after D: a night's later work in the same database. */
async function poison(db: Client): Promise<void> {
  const future = "2026-10-30";
  await seedLesson(db, "L-9", "L2", { critic: true, d: future });
  // a later grade and a failing critique for lessons known at D
  await db.execute({
    sql: `INSERT INTO lesson_grade (lesson_id, seq, grade, split_version, window, n, blocks, B, state_text, run_id, d)
          VALUES ('L-2', 2, 'retired', 1, NULL, 0, 0, 0, '', 'later', ?)`,
    args: [future],
  });
  await addCritique(
    db,
    "lesson",
    "L-1",
    challengerChecks(0, 120, { 2: "fail" }),
    false,
    future,
    "later",
  );
  const ch = (await db.execute("SELECT id FROM challenger")).rows[0]!.id as string;
  await addCritique(db, "challenger", ch, challengerChecks(60, 120), false, future, "later");
  await db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at)
          VALUES (?, 'ZZ2', ?, 'dq-z', 'warn', '2026-10-30T08:00:00.000Z')`,
    args: [MARKET, future],
  });
  await db.execute({
    sql: `INSERT INTO comparison_finding (id, pair_id, direction, detected_d, look_due_d)
          VALUES ('cf:z:2026-10-30', 'F1.v1|F2.v1', 1, ?, '2026-12-30')`,
    args: [future],
  });
  await db.execute({
    sql: `INSERT INTO comparison_result (market, kind, pair_id, d, n_a, n_b, estimate, lower, upper, p, bh_rank,
            discovery, block, B, label) VALUES (?, 'nightly', 'F1.v1|F2.v1', ?, 99, 99, 5.0, 1.0, 9.0, NULL, NULL, 0, 5, 1000,
            'descriptive — not a finding')`,
    args: [MARKET, future],
  });
  await addNight(db, "2026-10-21");
  await addRun(db, `arena-learn:${MARKET}:2026-10-21`, "arena-learn", "2026-10-21");
}

async function run(db: Client): Promise<{ dump: string; facts: string }> {
  await learnDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS });
  await wordsDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS, llm });
  const facts = await readLearnFacts(db, {
    market: MARKET,
    d: D,
    calendar: await loadCalendar(db, MARKET),
    params: PARAMS,
  });
  return { dump: await dumpLearning(db), facts: JSON.stringify(facts) };
}

describe("TST-109 over the nightly A6 phases", () => {
  it("rows dated after D change no row of learn or words, and none of the facts the review reads", async () => {
    const clean = await baseWorld();
    const a = await run(clean);
    const dirty = await baseWorld();
    await poison(dirty);
    const b = await run(dirty);
    // the poisoned world holds extra rows of its own (they are after D); everything D produced is equal
    const strip = (s: string): string =>
      s
        .split("\n")
        .map((part) => {
          const rows = JSON.parse(part) as Record<string, string>[];
          return JSON.stringify(
            rows.filter(
              (r) =>
                !JSON.stringify(r).includes("2026-10-30") &&
                !JSON.stringify(r).includes("L-9") &&
                !JSON.stringify(r).includes("later"),
            ),
          );
        })
        .join("\n");
    expect(strip(b.dump)).toBe(strip(a.dump));
    expect(b.facts).toBe(a.facts);
  });

  it("the Lane-A input is bounded by D: a lesson graded after D is not in tonight's playbook", async () => {
    const db = await baseWorld();
    await poison(db);
    await learnDay(db, { market: MARKET, d: D, now: nowFor(D), params: PARAMS });
    const pb = (await db.execute("SELECT content FROM playbook_version")).rows.map((r) =>
      String(r.content),
    );
    expect(pb.length).toBeGreaterThan(0);
    expect(pb.join("\n")).not.toContain("L-9");
    expect(pb.join("\n")).toContain("L-1");
  });
});
