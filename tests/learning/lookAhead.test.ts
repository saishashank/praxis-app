// @vitest-environment node
// M6 T16 (TST-109 over A6 and the weekly learning run; D-110 #38, D-123, D-124): every row dated after D
// is poisoned (prices, a split, announcements, attribution, ledger rows, grades, comparison results and
// findings) and the outputs of `learn` and `words` for the nights up to D, and of the weekly learning
// run for its Saturday, must be byte-identical with and without the poison. The nightly part runs the
// golden scenario twice (clean = built through D, poisoned = built with poison after D); the weekly
// part runs the comparisons stage and the whole replay mode `learning`.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { reviewDay } from "@/lib/agents/batch3";
import { defaultAgentParams } from "@/lib/agents/params";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { learnDay } from "@/lib/learning/learnStage";
import { comparisonsStage, type WeeklyContext } from "@/lib/learning/weeklyStages";
import { wordsDay, type WordsLlm } from "@/lib/learning/wordsStage";
import { MemoryStore } from "@/lib/llm/store";
import { replayMain } from "@/lib/replay/cli";
import { buildSnapshot } from "@/lib/replay/snapshot";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "../agents/batch2bHarness";
import { buildGolden } from "../agents/batch2bScenario";
import { cleanupTempDbs } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { makeRouter } from "../llm/helpers";
import { world as learningWorld } from "./challengerFixtures";
import { SAT, lightWorld, seedLesson } from "./learnHelpers";

vi.setConfig({ testTimeout: 600000, hookTimeout: 600000 });
afterAll(cleanupTempDbs);

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const ser = (x: unknown): string =>
  JSON.stringify(x, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v));

const ATTR_SQL = `INSERT INTO attribution (subject_kind, subject_id, version, market, d, final, tags_json,
  mfe_ppm, mae_ppm, hold_sessions, cost_micro, slippage_micro, net_micro, excess_ppm, stress_ppm)
  VALUES ('ledger_row', ?, 1, ?, ?, 1, ?, 9, -9, 3, 1, 1, 100, ?, 5)`;
const attrTags = (family: string, entryD: string): string =>
  JSON.stringify({
    family,
    rule_version: `${family}.v1`,
    variant: family,
    tier: "U1",
    regime: null,
    entry_d: entryD,
  });

// ---- the nightly A6 phases over the golden world ----------------------------------------------------

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const LAST = 320;
const FIRST_LEARN = LAST - 2;
const d = (i: number): string => DATES[i]!;

const rulesOnly = (): WordsLlm => {
  const store = new MemoryStore();
  return {
    r5Router: makeRouter("rules-only", [], store).router,
    providers: [],
    routerFor: () => makeRouter("rules-only", [], store).router,
    store,
  };
};

/** Rows that exist only after D, on top of the poisoned bars of `buildGolden({ poisonAfter })`. */
async function poisonNight(db: Client): Promise<void> {
  const future = d(LAST + 3);
  await db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
          VALUES (?, 'ZZ05', 'POISON-2', ?, ?, NULL, 1, 'Upgrades earnings guidance', NULL, 'synthetic')`,
    args: [MARKET, `${future}T01:00:00.000Z`, `${future}T01:01:00.000Z`],
  });
  const sig = await rows(db, "SELECT id FROM signal WHERE d <= ? ORDER BY id LIMIT 1", [d(LAST)]);
  await db.execute({
    sql: `INSERT INTO ledger_row (id, signal_id, group_key, entry_d, qty, fill_in_micro, brok_in_micro,
            stress_in_micro, timed, forward) VALUES ('POISON-LR', ?, NULL, ?, 10, 1000000, 0, 1000000, 0, 1)`,
    args: [String(sig[0]!.id), future],
  });
  for (const [i, fam] of ["F1", "F2"].entries()) {
    await db.execute({
      sql: ATTR_SQL,
      args: [`poison-${i}`, MARKET, future, attrTags(fam, future), 900_000 * (i + 1)],
    });
  }
  await seedLesson(db, "L-POISON", "L3", { critic: true, d: future });
  await db.execute({
    sql: `INSERT INTO comparison_result (market, kind, pair_id, d, n_a, n_b, estimate, lower, upper, p, bh_rank,
            discovery, block, B, label) VALUES (?, 'nightly', 'F1.v1|F2.v1', ?, 99, 99, 5.0, 1.0, 9.0, NULL, NULL, 0, 5, 1000,
            'descriptive — not a finding')`,
    args: [MARKET, future],
  });
  await db.execute({
    sql: `INSERT INTO comparison_finding (id, pair_id, direction, detected_d, look_due_d)
          VALUES ('cf:poison', 'F1.v1|F2.v1', 1, ?, ?)`,
    args: [future, addDays(future, 60)],
  });
}

/** Every table the phases write, restricted to what is dated by D. */
async function dumpUpToD(db: Client): Promise<string> {
  const day = d(LAST);
  const parts: string[] = [];
  for (const [sql, args] of [
    ["SELECT * FROM plan_item WHERE d <= ? ORDER BY market, d, rank", [day]],
    ["SELECT * FROM plan_review WHERE plan_d <= ? ORDER BY market, plan_d, rank", [day]],
    ["SELECT * FROM comparison_result WHERE d <= ? ORDER BY market, kind, pair_id, d", [day]],
    ["SELECT * FROM comparison_finding WHERE detected_d <= ? ORDER BY id", [day]],
    ["SELECT * FROM critique WHERE d <= ? ORDER BY subject_kind, subject_id, run_id", [day]],
    ["SELECT * FROM playbook_version ORDER BY market, agent, n", []],
    ["SELECT * FROM lesson_grade WHERE d <= ? ORDER BY lesson_id, seq", [day]],
    ["SELECT * FROM attribution WHERE d <= ? ORDER BY subject_kind, subject_id, version", [day]],
    ["SELECT * FROM ledger_row WHERE entry_d <= ? ORDER BY id", [day]],
    ["SELECT id, state, state_d, ready FROM challenger ORDER BY id", []],
    [
      "SELECT scope, metric, d, value_json FROM replay_stat WHERE run_id LIKE 'arena-words%' OR run_id LIKE 'arena-learn%' ORDER BY run_id, scope, metric",
      [],
    ],
    [
      "SELECT job, concurrency_key, status FROM run_record WHERE scheduled_for <= ? ORDER BY id",
      [day],
    ],
  ] as [string, string[]][]) {
    parts.push(ser(await rows(db, sql, args)));
  }
  return parts.join("\n");
}

async function nightsWorld(poisoned: boolean): Promise<{ dump: string; futureRows: number }> {
  const db = await freshReplayDb();
  if (poisoned) await buildGolden(db, { poisonAfter: LAST });
  else await buildGolden(db, { through: LAST });
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  await runNights(db, params, 295, LAST, async (day) => {
    await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
    if (day < d(FIRST_LEARN)) return;
    if (poisoned && day === d(LAST)) await poisonNight(db);
    await learnDay(db, { market: MARKET, d: day, replay: true, now: NOW, params });
    if (day === d(LAST)) {
      await wordsDay(db, {
        market: MARKET,
        d: day,
        replay: true,
        now: NOW,
        params,
        llm: rulesOnly,
      });
    }
  });
  const future = Number(
    (await rows(db, "SELECT COUNT(*) AS n FROM attribution WHERE d > ?", [d(LAST)]))[0]!.n,
  );
  return { dump: await dumpUpToD(db), futureRows: future };
}

describe("TST-109 over the nightly A6 phases (golden world)", () => {
  it("poisoned prices, events, attribution, ledger rows, grades and comparisons after D change nothing learn or words wrote up to D", async () => {
    const clean = await nightsWorld(false);
    const poisoned = await nightsWorld(true);
    expect(clean.futureRows).toBe(0);
    expect(poisoned.futureRows).toBe(2); // the poison was there, and learn left it alone
    expect(poisoned.dump).toBe(clean.dump);
    expect(clean.dump).toContain("arena-learn"); // not vacuous: the learn and words runs wrote rows
  });
});

// ---- the weekly learning run ---------------------------------------------------------------------------------

describe("TST-109 over the weekly comparisons stage", () => {
  const SATURDAY = SAT; // 2026-10-17; its Friday is 2026-10-16
  async function stage(poison: boolean): Promise<string> {
    const db = await lightWorld();
    const days: string[] = [];
    for (let x = "2026-08-03"; days.length < 50; x = addDays(x, 1)) if (!isWeekend(x)) days.push(x);
    for (const [i, x] of days.entries()) {
      await db.execute({
        sql: ATTR_SQL,
        args: [`a-${i}`, MARKET, addDays(x, 1), attrTags("F1", x), 1000 + (i % 7) * 50],
      });
      await db.execute({
        sql: ATTR_SQL,
        args: [`b-${i}`, MARKET, addDays(x, 1), attrTags("F2", x), 400 + (i % 5) * 80],
      });
    }
    if (poison) {
      for (let i = 0; i < 40; i += 1) {
        const x = addDays("2026-10-19", i);
        await db.execute({
          sql: ATTR_SQL,
          args: [`pa-${i}`, MARKET, addDays(x, 1), attrTags("F1", x), -5_000_000 - i],
        });
        await db.execute({
          sql: ATTR_SQL,
          args: [`pb-${i}`, MARKET, addDays(x, 1), attrTags("F2", x), 5_000_000 + i],
        });
      }
      await seedLesson(db, "L-9", "L3", { critic: true, d: "2026-10-30" });
      await db.execute({
        sql: `INSERT INTO comparison_finding (id, pair_id, direction, detected_d, look_due_d)
              VALUES ('cf:p', 'F1.v1|F2.v1', 1, '2026-10-19', '2026-10-22')`,
        args: [],
      });
    }
    const ctx = {
      db,
      market: MARKET,
      d: SATURDAY,
      params: defaultAgentParams(),
      runId: "replay:learning:AU:test",
      calendar: await loadCalendar(db, MARKET),
    } as unknown as WeeklyContext;
    const out = await comparisonsStage(ctx);
    return ser([
      out,
      await rows(db, "SELECT * FROM comparison_result WHERE d <= ? ORDER BY kind, pair_id, d", [
        SATURDAY,
      ]),
      await rows(db, "SELECT * FROM comparison_finding WHERE detected_d <= ? ORDER BY id", [
        SATURDAY,
      ]),
    ]);
  }

  it("attribution, findings and grades dated after the run week change no comparison row or statistic", async () => {
    const clean = await stage(false);
    const poisoned = await stage(true);
    expect(poisoned).toBe(clean);
    expect(clean).toContain("F1.v1|F2.v1"); // the pair was tested: the comparison is not vacuous
  });
});

describe("TST-109 over replay mode learning (whole run)", () => {
  const CODES = Array.from({ length: 12 }, (_, i) => `ZZ${String.fromCharCode(65 + i)}`);
  const SESSIONS = 640;
  const SATURDAY = "2029-06-30";
  function snapshotBytes(): Uint8Array {
    const cal = weekdayCalendar(SESSIONS, "2027-01-04");
    let s = 12345;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const bars: Record<string, unknown>[] = [];
    const universe: Record<string, unknown>[] = [];
    for (const code of CODES) {
      let c = 5 + rnd() * 5;
      universe.push({
        d: cal[0],
        code,
        status: "active",
        tier: "U1",
        mcap_est: 1e9,
        adv: 5e6,
        halted: 0,
      });
      for (const day of cal) {
        const o = c;
        c = Math.max(0.5, c * (1 + (rnd() - 0.48) * 0.04));
        bars.push({
          code,
          d: day,
          o: Number(o.toFixed(2)),
          h: Number((Math.max(o, c) * 1.005).toFixed(2)),
          l: Number((Math.min(o, c) * 0.995).toFixed(2)),
          c: Number(c.toFixed(2)),
          volume: Math.round(500_000 * (0.5 + rnd())),
        });
      }
    }
    let idx = 7000;
    const index_bars = cal.map((day) => {
      idx *= 1 + (rnd() - 0.48) * 0.01;
      const m = Math.round(idx * 1e6);
      return { index_code: "AXJO", d: day, o_micro: m, h_micro: m, l_micro: m, c_micro: m };
    });
    const calendar = cal.map((day) => ({
      d: day,
      kind: "session",
      close_time: null,
      confirmed: 1,
    }));
    return buildSnapshot({
      from: cal[0]!,
      to: cal[cal.length - 1]!,
      inputs: { calendar, universe, bars, index_bars, corporate_actions: [], announcements: [] },
    }).bytes;
  }
  const handle = (db: Client) =>
    new Proxy(db, {
      get: (t, k) => {
        if (k === "close") return () => undefined;
        const v = Reflect.get(t, k) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });

  async function weekly(poison: boolean, bytes: Uint8Array): Promise<string> {
    const { db } = await learningWorld(["F1"]);
    if (poison) {
      for (const fam of ["F1", "F2"]) {
        for (let i = 0; i < 30; i += 1) {
          const x = addDays("2029-07-02", i);
          await db.execute({
            sql: ATTR_SQL,
            args: [
              `pw-${fam}-${i}`,
              MARKET,
              addDays(x, 1),
              attrTags(fam, x),
              fam === "F1" ? -7_000_000 : 7_000_000,
            ],
          });
        }
      }
      await seedLesson(db, "L-W", "L3", { critic: true, d: "2029-07-05" });
    }
    const lines: string[] = [];
    const code = await replayMain(
      ["--mode", "learning", "--date", SATURDAY],
      { TURSO_MAIN_URL: "file:test", COMMIT_SHA: "c".repeat(40) },
      {
        openDb: () => handle(db),
        out: (s: string) => lines.push(s),
        params: defaultAgentParams(),
        prepareSnapshot: async () => bytes,
        nodeVersion: "v22",
      },
    );
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^replay learning: complete/);
    return ser([
      await rows(db, "SELECT id, kind, snapshot_sha, params_sha FROM replay_run"),
      await rows(
        db,
        "SELECT scope, metric, d, value_json FROM replay_stat WHERE scope <> 'run' ORDER BY scope, metric, d",
      ),
      await rows(db, "SELECT * FROM factor_bucket_stat ORDER BY 1, 2, 3, 4"),
      await rows(db, "SELECT * FROM comparison_result WHERE d <= ? ORDER BY kind, pair_id, d", [
        SATURDAY,
      ]),
      await rows(db, "SELECT * FROM lesson_grade WHERE d <= ? ORDER BY lesson_id, seq", [SATURDAY]),
    ]);
  }

  it("rows dated after the run date change no stage output, statistic, digest or stored table of the week", async () => {
    const bytes = snapshotBytes();
    const clean = await weekly(false, bytes);
    const poisoned = await weekly(true, bytes);
    expect(poisoned).toBe(clean);
    expect(clean).toContain("stage:factors");
  });
});
