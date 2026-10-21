// @vitest-environment node
// M6 T12: the weekly learning run's stages on a synthetic world that produces signals (the three-year
// replay harness, ZZ codes): lessons, factor buckets and the challenger stage write through their
// modules, are idempotent, read development rows only, and charge no validation access when the
// entry-count pre-check is insufficient.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { defaultAgentParams } from "@/lib/agents/params";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import {
  challengersStage,
  comparisonsStage,
  factorsStage,
  lessonsStage,
  rollsStage,
  toLessonObs,
  type WeeklyContext,
} from "@/lib/learning/weeklyStages";
import {
  ledgerDigest,
  replayLedger,
  type EntryFacts,
  type LedgerResult,
} from "@/lib/replay/ledger";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { buildDataset, freshReplayDb } from "../arena/replayHarness";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";
import { MARKET, ownerChallenger, rows as sqlRows } from "./challengerFixtures";

const params = defaultAgentParams();
let dates: string[] = [];
let world: ReturnType<typeof buildCohortWorld>;
let ledger: LedgerResult;
const facts = new Map<string, EntryFacts>();

beforeAll(async () => {
  const rdb = await freshReplayDb();
  const ds = await buildDataset(rdb, { startD: "2030-01-07", sessions: 780, seed: 11 });
  dates = ds.dates;
  world = buildCohortWorld(dates, await seriesFromHarness(rdb, dates, ds.spec), params);
  ledger = replayLedger(world, { params, factsSink: facts });
}, 120_000);
afterAll(cleanupTempDbs);

/** A lineage with a stored, non-deferred split inside the synthetic calendar. */
async function addCraftedSplit(db: Client, family: string): Promise<void> {
  await db.execute({
    sql: "INSERT INTO lineage (id, created_d, parent) VALUES (?, ?, NULL)",
    args: [`${MARKET}:${family}`, "2029-12-01"],
  });
  await db.execute({
    sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
            purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
            dev_end_d, deferred_until_d, reason, measured_on_run)
          VALUES (?, 1, 5, 130, 150, 10, ?, ?, ?, ?, ?, ?, NULL, 'create', NULL)`,
    args: [
      `${MARKET}:${family}`,
      dates[779]!,
      dates[641]!,
      dates[771]!,
      dates[481]!,
      dates[631]!,
      dates[470]!,
    ],
  });
}

async function world2(): Promise<{ db: Client; ctx: WeeklyContext }> {
  const db = await freshDb("main");
  await seedRuleVersions(db, { market: MARKET, d: "2029-12-01" });
  await addCraftedSplit(db, "F1");
  await addCraftedSplit(db, "F4");
  const ctx: WeeklyContext = {
    db,
    market: MARKET,
    d: "2032-01-03",
    params,
    runId: "replay:learning:AU:test",
    world: world as never,
    ledger,
    facts,
    calendar: [],
  };
  return { db, ctx };
}

const count = async (db: Client, sql: string): Promise<number> =>
  Number((await sqlRows(db, sql))[0]!.n);

describe("lessons stage", () => {
  it("grades development rows once and writes nothing the second time", async () => {
    const { db, ctx } = await world2();
    expect(ledger.entries.length).toBeGreaterThan(0);
    const a = await lessonsStage(ctx);
    const v = (a.stats[0]!.value as Record<string, number>).lessonsCreated;
    expect(await count(db, "SELECT COUNT(*) AS n FROM lesson")).toBe(v);
    // the lesson window of the F4 split is frozen from development sessions only
    const w = await sqlRows(db, "SELECT lineage_id, l2_end_d FROM lesson_window");
    for (const r of w) expect(String(r.l2_end_d) <= dates[470]!).toBe(true);
    const before = await count(
      db,
      "SELECT (SELECT COUNT(*) FROM lesson) + (SELECT COUNT(*) FROM lesson_grade) AS n",
    );
    const b = await lessonsStage(ctx);
    expect(b.stats[0]!.value).toMatchObject({ lessonsCreated: 0, gradesWritten: 0 });
    expect(
      await count(
        db,
        "SELECT (SELECT COUNT(*) FROM lesson) + (SELECT COUNT(*) FROM lesson_grade) AS n",
      ),
    ).toBe(before);
  });
});

describe("facts sink and the F4 filter switch", () => {
  it("collecting row facts does not change the ledger; the live default keeps the event filter", () => {
    expect(ledgerDigest(replayLedger(world, { params }))).toBe(ledgerDigest(ledger));
    expect(facts.size).toBe(ledger.entries.length);
    const off = replayLedger(world, {
      params,
      familyOptions: { families: ["F4"], f4EventFilterOff: true },
    });
    const on = replayLedger(world, { params, familyOptions: { families: ["F4"] } });
    expect(ledgerDigest(on)).toBe(
      ledgerDigest(
        replayLedger(world, {
          params,
          familyOptions: { families: ["F4"], f4EventFilterOff: false },
        }),
      ),
    );
    expect(off.entries.length).toBeGreaterThanOrEqual(on.entries.length);
  });
});

describe("lesson observations", () => {
  it("map a closed ledger row: development part, excess and net as numbers, tier, regime, classes, holding sessions", () => {
    const idx = new Map(dates.map((d, i) => [d, i]));
    const e = ledger.entries[0]!;
    const o = toLessonObs(e, facts.get(e.row.id), idx);
    expect(o).toMatchObject({
      part: "development",
      kind: "executed",
      family: "F4",
      id: e.row.id,
      entryD: e.row.entry_d,
      observedD: e.row.exit_d,
      tier: "U1",
      exitKind: e.row.exit_tag,
      stressExcess: null,
      blockedBy: null,
      evidenceClasses: [],
    });
    expect(o.holdSessions).toBe(idx.get(e.row.exit_d!)! - idx.get(e.row.entry_d)!);
    expect(o.net).toBeCloseTo(Number(e.net!.num) / Number(e.net!.den), 12);
  });
});

describe("lessons stage on a deferred split", () => {
  it("runs on all development rows without a lesson window and never grades above L0", async () => {
    const db = await freshDb("main");
    await seedRuleVersions(db, { market: MARKET, d: "2029-12-01" });
    await db.execute({
      sql: "INSERT INTO lineage (id, created_d, parent) VALUES ('AU:F4', '2029-12-01', NULL)",
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
              purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
              dev_end_d, deferred_until_d, reason, measured_on_run)
            VALUES ('AU:F4', 1, 5, 130, 150, 10, ?, NULL, NULL, NULL, NULL, NULL, ?, 'create', NULL)`,
      args: [dates[779]!, dates[779]!],
    });
    const ctx: WeeklyContext = {
      db,
      market: MARKET,
      d: "2032-01-03",
      params,
      runId: "replay:learning:AU:test",
      world: world as never,
      ledger,
      facts,
      calendar: [],
    };
    const out = await lessonsStage(ctx);
    const v = out.stats[0]!.value as { lessonsCreated: number; gradesWritten: number };
    expect(v.gradesWritten).toBe(0); // this world draws no controls, so no row has an excess figure
    for (const g of await sqlRows(db, "SELECT DISTINCT grade FROM lesson_grade")) {
      expect(g.grade).toBe("L0"); // never above L0 without a window
    }
    expect(await count(db, "SELECT COUNT(*) AS n FROM lesson_window")).toBe(0);
    expect(out.stats[0]!.value).toMatchObject({ lineages: 1 });
  });
});

describe("AGT-112 factors stage", () => {
  it("buckets development rows of families with a split and is idempotent", async () => {
    const { db, ctx } = await world2();
    const a = await factorsStage(ctx);
    const value = a.stats[0]!.value as { rows: number; written: number; unchanged: number };
    expect(value.rows).toBe(value.written);
    expect(await count(db, "SELECT COUNT(*) AS n FROM factor_bucket_stat")).toBe(value.rows);
    expect(a.file?.name).toBe("factors");
    for (const r of await sqlRows(
      db,
      "SELECT DISTINCT family, split_version FROM factor_bucket_stat",
    )) {
      expect(r.family).toBe("F4"); // the only family with development rows in this world
      expect(Number(r.split_version)).toBe(1);
    }
    const b = await factorsStage(ctx);
    expect(b.stats[0]!.value).toMatchObject({ written: 0, unchanged: value.rows });
  });
});

describe("challengers stage", () => {
  it("generator on development only; a proposed Owner version without enough entries stays proposed and nothing is charged", async () => {
    const { db, ctx } = await world2();
    const made = await ownerChallenger(db, 1, "2030-01-08");
    expect(made.status).toBe("created");
    const trialsBefore = await count(
      db,
      "SELECT COUNT(*) AS n FROM trial_ledger WHERE kind = 'validation_access'",
    );
    const out = await challengersStage(ctx);
    const v = out.stats[0]!.value as {
      families: { family: string; generator?: string; evidence?: Record<string, string> }[];
    };
    const f1 = v.families.find((f) => f.family === "F1")!;
    expect(f1.generator).toBeDefined();
    expect(Object.values(f1.evidence!)).toEqual(["proposed:insufficient"]);
    expect(v.families.find((f) => f.family === "F2")).toMatchObject({ skipped: "no_split" });
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM trial_ledger WHERE kind = 'validation_access'"),
    ).toBe(trialsBefore);
  });

  it("a challenger in replay with too few validation entries is insufficient and uncharged (decision 47)", async () => {
    const { db, ctx } = await world2();
    const made = await ownerChallenger(db, 2, "2030-01-08");
    if (made.status !== "created") throw new Error("not created");
    await transitionChallenger(
      db,
      { id: made.id, to: "replay", d: "2030-01-08", actor: "u-owner", reason: "test" },
      { shakedownSessions: params.learning.shakedownSessions },
    );
    const out = await challengersStage(ctx);
    const f1 = (
      out.stats[0]!.value as { families: { family: string; evidence?: Record<string, string> }[] }
    ).families.find((f) => f.family === "F1")!;
    expect(f1.evidence![made.id]).toBe("insufficient");
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM trial_ledger WHERE kind = 'validation_access'"),
    ).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM validation_result")).toBe(0);
  });
});

describe("comparisons and rolls stages with nothing to do", () => {
  it("write no comparison rows without forward attribution and roll nothing without a promotion", async () => {
    const { db, ctx } = await world2();
    const c = await comparisonsStage(ctx);
    expect(c.stats[0]!.value).toMatchObject({ pairs: 0, tested: 0, looks: 0 });
    const r = await rollsStage(ctx);
    expect(r.stats[0]!.value).toEqual({ awaiting: 0, results: [] });
    expect(await count(db, "SELECT COUNT(*) AS n FROM lineage_split")).toBe(2);
  });
});
