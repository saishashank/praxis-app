// @vitest-environment node
// AT-22 Nightly loop (M6 T18; ARN-060...069, KB-030/031, AGT-001/002/004/050, NFR-011). Verbatim:
// "Attribution, comparisons, graded lessons and <= 5-item plan written before 19:45; Lane A changes
// logged; no rule changed by Lane A". The real `learn` and `words` phases over a migrated database with
// the real cohorts, mock LLM, synthetic ZZ data, a mock clock. Heavier cover (named, not repeated):
// tests/learning/learnNights.test.ts (golden 3-night world: attribution of every trade, forward row and
// blocked signal; ledger untouched), learnStage.test.ts, laneA.test.ts, wordsStage.test.ts,
// lookAhead.test.ts (TST-109), tests/time/m6Jobs.test.ts (TST-123 matrix).
// PENDING (Owner / staging, not evidenced here): the recorded staging run (TST-115) on the release that
// applies migrations 0007...0010; any live R3 wording (no live model is assigned, D-110).
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { currentKbVersion } from "@/lib/learning/kbVersion";
import { learnDay, type LearnResult } from "@/lib/learning/learnStage";
import { wordsDay, type WordsLlm } from "@/lib/learning/wordsStage";
import { MemoryStore } from "@/lib/llm/store";
import { cleanupTempDbs } from "../../db/helpers";
import { makeRouter } from "../../llm/helpers";
import {
  PARAMS,
  addCritique,
  addNight,
  challengerChecks,
  dumpLearning,
  rows,
  seedLesson,
  shakedownChallenger,
} from "../../learning/learnHelpers";
import { MARKET } from "../../learning/challengerFixtures";
import { arenaWorld } from "./arenaWorld";

const PREV = "2026-10-19";
const D = "2026-10-20";
/** 19:20 Melbourne (AEDT, UTC+11, in force on these dates): a mock clock before the 19:45 marker. */
const clockAt = (d: string) => (): string => `${d}T08:20:00.000Z`;
const learn = (db: Client, d: string) =>
  learnDay(db, { market: MARKET, d, now: clockAt(d), params: PARAMS });
const melbourne = (iso: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Melbourne",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

const weekdays = (from: string, n: number): string[] => {
  const out: string[] = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (!isWeekend(d)) out.push(d);
  return out;
};
const DAYS = weekdays("2026-08-03", 45);

/** Forward-ledger attribution rows of one family (40 finished rows) so a nightly pair has n >= 30. */
async function seedAttribution(db: Client, family: string, base: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const entry = DAYS[i]!;
    await db.execute({
      sql: `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json, mfe_ppm,
              mae_ppm, hold_sessions, cost_micro, slippage_micro, net_micro, excess_ppm, stress_ppm)
            VALUES ('ledger_row', ?, 1, ?, ?, 1, ?, 10, -10, 3, 1, 1, 100, ?, 5)`,
      args: [
        `${family}-row-${i}`,
        MARKET,
        addDays(entry, 4),
        JSON.stringify({
          family,
          rule_version: `${family}.v1`,
          variant: family,
          tier: null,
          regime: null,
          entry_d: entry,
        }),
        base + (i % 7) * 50,
      ],
    });
  }
}

/** The real cohorts, the v1 rule seed, two finished nights, lessons of every grade, a challenger. */
async function nightWorld(): Promise<Client> {
  const db = await arenaWorld();
  await db.execute({ sql: "UPDATE market SET mode = 'full' WHERE code = ?", args: [MARKET] });
  for (const d of [PREV, D]) await addNight(db, d);
  await seedLesson(db, "L-1", "L2", { critic: true });
  await seedLesson(db, "L-2", "L1", { critic: true });
  await seedLesson(db, "L-3", "L0");
  const id = await shakedownChallenger(db, 0, "2026-10-06");
  await db.execute({
    sql: "UPDATE challenger SET state = 'review', state_d = '2026-10-14' WHERE id = ?",
    args: [id],
  });
  await addCritique(db, "challenger", id, challengerChecks(), true, "2026-10-14");
  await db.execute({
    sql: `INSERT INTO data_quality_flag (market, code, d, check_id, severity, raised_at)
          VALUES (?, 'ZZ1', ?, 'dq-a', 'warn', '2026-10-19T08:00:00.000Z')`,
    args: [MARKET, PREV],
  });
  await seedAttribution(db, "F1", 1000);
  await seedAttribution(db, "F2", 400);
  return db;
}

let db: Client;
let first: LearnResult;
let second: LearnResult;
beforeAll(async () => {
  db = await nightWorld();
  first = await learn(db, PREV);
  second = await learn(db, D);
});
afterAll(cleanupTempDbs);

describe("AT-22 Nightly loop", () => {
  it("writes attribution, comparisons, graded lessons and the plan, all finished before 19:45", async () => {
    expect(first.status).toBe("success");
    expect(second).toMatchObject({ status: "success", reason: null });
    expect(second.stats.variant).toBe("full");
    expect(second.stats.stepsFailed).toEqual([]);
    expect(second.stats.attribution).not.toBeNull(); // attribution ran (every trade: learnNights.test.ts)
    // every run record of the phase finished before the 19:45 marker, Melbourne time
    const runs = await rows(
      db,
      "SELECT concurrency_key AS k, started_at, ended_at FROM run_record WHERE job = 'arena-learn'",
    );
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(melbourne(String(r.ended_at)) < "19:45", String(r.k)).toBe(true);
      expect(String(r.ended_at) >= String(r.started_at)).toBe(true);
    }
    // the loop budget keeps it inside the window: <= 5 minutes (NFR-011)
    expect(PARAMS.learning.learningLoopMinutes).toBeLessThanOrEqual(5);
  });

  it("nightly comparisons are descriptive, with their label (ARN-062)", async () => {
    const cmp = await rows(
      db,
      "SELECT kind, pair_id, n_a, n_b, label FROM comparison_result WHERE d = ?",
      [D],
    );
    expect(cmp.length).toBeGreaterThan(0);
    expect(second.stats.comparisons).toBe(cmp.length);
    for (const r of cmp) {
      expect(r.kind).toBe("nightly");
      expect(
        String(r.label) === "descriptive — not a finding" ||
          /^not enough data \(n = \d+\)$/.test(String(r.label)),
      ).toBe(true);
    }
    expect(cmp.some((r) => r.label === "descriptive — not a finding")).toBe(true);
  });

  it("every lesson carries a grade; the plan has at most 5 items, each with reason, lesson id, lane and measure (ARN-063, ARN-066)", async () => {
    const grades = await rows(
      db,
      `SELECT g.lesson_id, g.grade FROM lesson_grade g
        WHERE g.seq = (SELECT MAX(seq) FROM lesson_grade WHERE lesson_id = g.lesson_id)
        ORDER BY g.lesson_id`,
    );
    expect(grades.map((g) => String(g.lesson_id))).toEqual(["L-1", "L-2", "L-3"]);
    for (const g of grades) expect(["L0", "L1", "L2", "L3"]).toContain(String(g.grade));
    const plan = await rows(
      db,
      "SELECT rank, reason, lesson_id, lane, measure_json FROM plan_item WHERE d = ? ORDER BY rank",
      [D],
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(5);
    expect(plan.map((p) => Number(p.rank))).toEqual(plan.map((_, i) => i + 1));
    for (const p of plan) {
      expect(String(p.reason).length).toBeGreaterThan(0);
      expect(p.lesson_id !== null || String(p.reason).startsWith("no-lesson:")).toBe(true);
      expect(String(p.lane).length).toBeGreaterThan(0);
      const m = JSON.parse(String(p.measure_json)) as { metric: string; check_d: string };
      expect(m.metric.length).toBeGreaterThan(0);
      expect(m.check_d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // yesterday's plan was reviewed tonight, once
    const reviewed = await rows(
      db,
      "SELECT plan_d, reviewed_d, outcome FROM plan_review WHERE reviewed_d = ?",
      [D],
    );
    expect(reviewed.length).toBeGreaterThan(0);
    expect(reviewed.every((r) => r.plan_d === PREV)).toBe(true);
  });

  it("Lane A changes are logged: change ledger, playbook version, KB version; L0/L1 only under 'Unproven notes' (KB-031)", async () => {
    expect(second.stats.laneA!.changes + first.stats.laneA!.changes).toBeGreaterThan(0);
    const ledger = await rows(db, "SELECT kind, target, actor FROM change_ledger ORDER BY id");
    expect(ledger.length).toBeGreaterThan(0);
    expect(await currentKbVersion(db, MARKET)).not.toBe("kb-0");
    const pb = String(
      (
        await rows(db, "SELECT content FROM playbook_version WHERE agent = 'A1' ORDER BY n DESC")
      )[0]!.content,
    );
    const at = pb.indexOf("Unproven notes");
    expect(at).toBeGreaterThan(-1);
    const guidance = pb.slice(0, at);
    const unproven = pb.slice(at);
    expect(unproven).toContain("L-2"); // L1: a hypothesis, stated as such
    expect(guidance).not.toContain("L-2");
    expect(pb).not.toContain("L-3"); // L0 is never in a playbook
  });

  it("a second run of the same night writes nothing (idempotent)", async () => {
    const before = await dumpLearning(db);
    expect((await learn(db, D)).status).toBe("already_done");
    expect(await dumpLearning(db)).toBe(before);
  });

  it("without batch 3 the step runs on what exists and marks itself partial (AGT-004, AGT-050)", async () => {
    const d2 = await nightWorld();
    await d2.execute("DELETE FROM run_record WHERE job = 'arena-review'");
    const r = await learn(d2, D);
    expect(r).toMatchObject({ status: "degraded", reason: "batch3_missing" });
    expect(r.stats.variant).toBe("partial");
    expect(r.stats.laneA).not.toBeNull();
  });
});

// ---- no rule changed by Lane A: a property over random lesson sets --------------------------------------

/** mulberry32: a small seeded generator, so the "random" sets are the same on every machine. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RULE_TABLES = [
  "rule_version",
  "rule_version_status",
  "execution",
  "cohort",
  "cohort_event",
  "arena_order",
  "lineage_split",
  "config_version",
  "arena_control",
  "promotion",
  "challenger",
  "challenger_event",
] as const;

async function snapshot(d: Client, tables: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const t of tables) {
    out.push(
      `${t}:${JSON.stringify((await d.execute(`SELECT * FROM "${t}"`)).rows, (_, v) =>
        typeof v === "bigint" ? String(v) : v,
      )}`,
    );
  }
  return out;
}

describe("AT-22 no rule changed by Lane A (property over random lesson sets)", () => {
  it.each([1, 2, 3, 4, 5])(
    "seed %i: rule versions, executions, cohort parameters, orders, splits and challenger rows are byte-identical after the night",
    async (seed) => {
      const r = rng(seed * 7919);
      const d2 = await arenaWorld();
      await d2.execute({ sql: "UPDATE market SET mode = 'full' WHERE code = ?", args: [MARKET] });
      await addNight(d2, D);
      const grades = ["L0", "L1", "L2", "L3"] as const;
      const n = 3 + Math.floor(r() * 5);
      for (let i = 0; i < n; i += 1) {
        const verdict = r();
        await seedLesson(d2, `L-${i}`, grades[Math.floor(r() * 4)]!, {
          critic: verdict < 0.2 ? null : verdict < 0.4 ? false : true,
        });
      }
      const before = await snapshot(d2, RULE_TABLES);
      const res = await learn(d2, D);
      expect(res.status).toBe("success");
      expect(await snapshot(d2, RULE_TABLES)).toEqual(before);
    },
  );
});

// ---- AGT-001: LLMs never compute numbers (rules-only and mock give identical numbers) --------------------

describe("AT-22 words never changes a number (AGT-001)", () => {
  const llm = (mode: "rules-only" | "mock"): WordsLlm => {
    const store = new MemoryStore();
    return {
      r5Router: makeRouter(mode, [], store).router,
      providers: [],
      routerFor: () => makeRouter(mode, [], store).router,
      store,
    };
  };
  const NUMERIC = [
    "attribution",
    "comparison_result",
    "lesson_grade",
    "plan_item",
    "plan_review",
    "change_ledger",
    "playbook_version",
    "rule_version",
  ];

  it("the numeric tables are identical before and after words, and identical for rules-only and mock", async () => {
    const dumps: string[] = [];
    for (const mode of ["rules-only", "mock"] as const) {
      const d2 = await nightWorld();
      await learn(d2, PREV);
      await learn(d2, D);
      const before = await snapshot(d2, NUMERIC);
      const w = await wordsDay(d2, {
        market: MARKET,
        d: D,
        now: clockAt(D),
        params: PARAMS,
        llm: () => llm(mode),
      });
      expect(["success", "degraded"]).toContain(w.status);
      const after = await snapshot(d2, NUMERIC);
      expect(after).toEqual(before);
      dumps.push(after.join("\n"));
    }
    expect(dumps[0]).toBe(dumps[1]);
  });
});

// ---- KB-051 / LLM-036: user text never reaches an LLM context -------------------------------------------

describe("AT-22 annotations are never part of an LLM context (KB-051, LLM-036)", () => {
  it("no LLM, context-pack, playbook or wording module reads the annotation table", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const root = resolve(__dirname, "../../../src/lib");
    const files = [
      ...readdirSync(join(root, "llm")).map((f) => join(root, "llm", f)),
      join(root, "learning", "playbook.ts"),
      join(root, "learning", "laneA.ts"),
      join(root, "learning", "wordsStage.ts"),
      join(root, "review", "sections.ts"),
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
      expect(src, f).not.toMatch(/\bannotation\b/i);
    }
  });
});
