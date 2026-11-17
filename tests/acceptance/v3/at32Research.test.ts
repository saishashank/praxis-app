// @vitest-environment node
// AT-32 complement proof for the M23 research tables and the night seam (M23 A1, D-1611, D-1613, D-1645; PRD-033, AT-73,
// AT-68 b): the proof of at32Opinions.test.ts, with the own-set of D-1645, the eight 0040 tables plus `trial_ledger` (the
// proposal charges) and `app_log` (the Owner-visible lines). Three things are proved on the golden ZZ world of AT-32:
//   1. the own-set is exactly those ten names, and every one of the eight tables exists;
//   2. the seam itself: the world run with the research night ON (the real call from the Cortex stage, every step a stub
//      today) and with it OFF (the call replaced by a no-op) is equal in every table outside the own-set, byte for byte,
//      and equals the AT-32 baseline (read only; the baseline file is never rewritten);
//   3. the complement is not vacuous: a row in a hashed table (a control) changes exactly that table's hash.
// Later tasks add their step's real run to `M23_STEP_WRITERS`; the proof then covers it. Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LEDGER_PATH } from "@/lib/research/ledgerFile";
import { runResearchNight, type ResearchStep } from "@/lib/research/night";
import { syncLedger } from "@/lib/research/steps/lookSync";
import { sectorIndexStep } from "@/lib/research/steps/sectorIndex";
import { monitorsStep } from "@/lib/research/steps/monitors";
import { annCalibrationStep } from "@/lib/research/steps/annCalibration";
import { labelEvalStep } from "@/lib/research/steps/labelEval";
import { metersStep } from "@/lib/research/steps/meters";
import { cleanupTempDbs } from "../../db/helpers";
import { STEELMAN_OWN, MIGRATION_OWNED, at32World, combineTables } from "./at32World";

vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const seam = vi.hoisted(() => ({ off: false, calls: 0 }));
vi.mock("@/lib/research/night", async (orig) => {
  const real = await orig<typeof import("@/lib/research/night")>();
  return {
    ...real,
    runResearchNight: async (...a: Parameters<typeof real.runResearchNight>) => {
      seam.calls += 1;
      if (seam.off) return { status: "ran" as const, ran: [], failed: [] };
      return real.runResearchNight(...a);
    },
  };
});

const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

/** D-1611, D-1645: the eight tables 0040 adds. */
const M23_OWN = [
  "research_prereg",
  "holdout_look_refusal",
  "research_result",
  "research_meter",
  "residual_monitor",
  "sector_index",
  "angle_proposal",
  "shock_stop_outcome",
] as const;
/**
 * D-1645: the existing tables the research night may also write (proposal charges, Owner-visible lines) and, since A2, the
 * look registry itself: the ledger import (lookSync) writes it only through the registry gate (D-1607).
 */
const M23_SHARED = ["trial_ledger", "app_log", "holdout_look"] as const;

const OWN = new Set<string>([...STEELMAN_OWN, ...M23_OWN, ...M23_SHARED]);

const WALLCLOCK: Record<string, readonly string[]> = {
  source_register_history: ["changed_at"],
  cortex_night: ["runtime_ms"],
};

type Dump = { perTable: Record<string, string>; rows: Record<string, number> };

/** The complement dump: every table except the own-set and the migration-owned ones. */
async function complementDump(db: Client): Promise<Dump> {
  const r = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const perTable: Record<string, string> = {};
  const rows: Record<string, number> = {};
  for (const name of r.rows.map((x) => String(x.name))) {
    if (OWN.has(name) || MIGRATION_OWNED.has(name)) continue;
    const skip = new Set(WALLCLOCK[name] ?? []);
    const cols = (await db.execute(`PRAGMA table_info(${name})`)).rows
      .map((c) => String(c.name))
      .filter((c) => !skip.has(c));
    const rs = await db.execute(
      `SELECT ${cols.join(", ")} FROM ${name} ORDER BY ${cols.map((_, i) => i + 1).join(", ")}`,
    );
    rows[name] = rs.rows.length;
    perTable[name] = sha(
      `${name}:${JSON.stringify(rs.rows.map((x) => cols.map((c) => String(x[c]))))}\n`,
    );
  }
  return { perTable, rows };
}

const TS = "2030-01-02T00:00:00Z";
const SHA = "a".repeat(64);
/**
 * What a research step may write, one valid row per own table (AU, the only enabled market). Later tasks add their step's
 * real run here (as a writer called on the "on" world); the proof then covers it.
 */
const M23_STEP_WRITERS: Array<(db: Client) => Promise<void>> = [
  async (db) => {
    const sql = [
      `INSERT INTO research_prereg (lineage, market, item, frozen_json, sha, created_at) VALUES ('L1', 'AU', 'CXA-003', '{}', '${SHA}', '${TS}')`,
      `INSERT INTO holdout_look_refusal (lineage, market, at, prereg_sha, caller) VALUES ('L1', 'AU', '${TS}', '${SHA}', 'test')`,
      `INSERT INTO research_result (lineage, market, looked_at, prereg_sha, n_setups, n_blocks, stats_json) VALUES ('L1', 'AU', '${TS}', '${SHA}', 1, 1, '{}')`,
      `INSERT INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at) VALUES ('AU', 'L1', '2030-01-02', 1, 30, NULL, 'collecting', '${TS}')`,
      `INSERT INTO residual_monitor (market, monitor, period, value_json, alarm, created_at) VALUES ('AU', 1, '2030-Q1', '{}', 0, '${TS}')`,
      `INSERT INTO sector_index (market, d, group_code, weighting, ret_ppm, level_ppm, n_members, map_as_of, created_at) VALUES ('AU', '2030-01-02', 'G1', 'equal', 0, 1000000, 3, '2030-01-01', '${TS}')`,
      `INSERT INTO angle_proposal (proposal_id, market, month, kind, state, created_at) VALUES ('${SHA}', 'AU', '2030-01', 'angle', 'refused_schema', '${TS}')`,
      `INSERT INTO shock_stop_outcome (market, family, origin, d_entry, d_shock, base_net_ppm, tight_net_ppm, created_at) VALUES ('AU', 'F1', 'o1', '2030-01-02', '2030-01-03', 0, 0, '${TS}')`,
    ];
    for (const s of sql) await db.execute(s);
  },
  // A2: the real lookSync step, one synthetic recorded look through the registry gate
  async (db) => {
    const plan = '{"hypothesis":"synthetic offline plan"}\n';
    const entry = {
      seq: 1,
      item: "CXA-003",
      lineage: "zz_sync",
      market: "AU",
      sha: sha(plan),
      preregPath: "docs/research/prereg/zz.json",
      lookedAt: TS,
      verdict: "NULL",
      nSetups: 2,
      nBlocks: 1,
      stats: {},
    };
    const files: Record<string, string> = {
      [LEDGER_PATH]: JSON.stringify({ format: 1, entries: [entry] }),
      "docs/research/prereg/zz.json": plan,
    };
    await syncLedger(db, { market: "AU", now: TS }, { read: (p) => files[p] ?? null });
  },
  // S1 (D-1670...D-1674): the real sector index step on the world's last session. The world has no classification, so it
  // writes no row here (AT-75 series proves the rows on a ZZ fixture); the run proves its reads touch nothing else.
  async (db) => {
    await sectorIndexStep.run(db, { market: "AU", d: "2031-04-08", now: TS });
  },
  // M1 (D-1614): the real monitors step, on the quarter before the night; it writes only residual_monitor and app_log
  async (db) => {
    await monitorsStep.run(db, { market: "AU", d: "2030-04-02", now: TS });
  },
  // M2 (D-1619...D-1622, D-1700...D-1703): the same monitors step now runs monitors 5 to 8; this night is the first one
  // after the quarter 2030-Q2 and reads the empty world (their reads touch the cortex, cohort and statement tables only).
  async (db) => {
    await monitorsStep.run(db, { market: "AU", d: "2030-07-02", now: TS });
  },
  // T2 (D-1635, D-1690...D-1694): the real announcement-calibration step. It freezes the plan of its 23 lineages, counts the
  // archive (empty on the golden world: n = 0) and writes one research_meter row; below the floor it takes no look.
  async (db) => {
    await annCalibrationStep.run(db, { market: "AU", d: "2031-04-08", now: TS });
  },
  // M3 (D-1720...D-1723): the real meters step (live-tested progress, the six mover rules, the intraday stream) and the real
  // label evaluation on the world's last session; they read the Cortex, mover, intraday and golden tables and write only
  // research_meter and the registry tables (the golden world has no halts, flags, candidates or golden labels, so no look)
  async (db) => {
    await metersStep.run(db, { market: "AU", d: "2031-04-08", now: TS });
  },
  async (db) => {
    await labelEvalStep.run(db, { market: "AU", d: "2031-04-08", now: TS });
  },
];

const base = JSON.parse(readFileSync(join(__dirname, "replay-hash.baseline.json"), "utf8")) as {
  at32: { hash: string; tables: Record<string, string> };
};
const baseNames = Object.keys(base.at32.tables).sort();
/** The baseline names outside the own-set: the two shared tables are not compared (a step may write them). */
const baseOutside = baseNames.filter((n) => !OWN.has(n));

describe("AT-32 (research): the M23 own-set, the seam and the complement proof (D-1645)", () => {
  it("the own-set is the steelman's own tables plus the eight 0040 tables, trial_ledger, app_log and holdout_look", () => {
    expect([...M23_OWN].sort()).toEqual([
      "angle_proposal",
      "holdout_look_refusal",
      "research_meter",
      "research_prereg",
      "research_result",
      "residual_monitor",
      "sector_index",
      "shock_stop_outcome",
    ]);
    expect(OWN.size).toBe(STEELMAN_OWN.size + 8 + 3);
    for (const t of M23_OWN) expect(STEELMAN_OWN.has(t), t).toBe(false);
  });

  it("the recorded night skips the seam; run live, the seam moves nothing outside the own-set; the hash equals the baseline", async () => {
    // the golden world is a recorded (replayed) AU night: the Cortex stage must not call the seam at all (D-1613)
    seam.off = false;
    seam.calls = 0;
    const on = await at32World();
    expect(seam.calls).toBe(0);
    const tables = (
      await on.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows.map((r) => String(r.name));
    for (const t of M23_OWN) expect(tables, `${t} exists`).toContain(t);

    const a = await complementDump(on);
    for (const t of M23_OWN) expect(Object.keys(a.perTable), t).not.toContain(t);
    // the world is not empty
    expect(a.rows.signal).toBeGreaterThan(0);
    expect(a.rows.decision_card).toBeGreaterThan(0);
    expect(a.rows.arena_order).toBeGreaterThan(0);
    // the AU world is byte-identical to the committed baseline (read only) outside the own-set
    expect(baseOutside.filter((n) => a.perTable[n] === undefined)).toEqual([]);
    expect(baseOutside.filter((n) => a.perTable[n] !== base.at32.tables[n])).toEqual([]);
    expect(combineTables(a.perTable, baseOutside)).toBe(
      combineTables(base.at32.tables, baseOutside),
    );

    // ON versus OFF on the same world: the live seam (every step a stub) is equal to no seam in every other table
    const d = String(
      (await on.execute("SELECT MAX(d) AS d FROM signal WHERE market = 'AU'")).rows[0]!.d,
    );
    const res = await runResearchNight(on, { market: "AU", d, now: TS });
    expect(res.status).toBe("ran");
    expect(res.ran).toHaveLength(7);
    const live = await complementDump(on);
    expect(live.perTable).toEqual(a.perTable);
    expect(live.rows).toEqual(a.rows);
    // the ledger import writes one plan, one look and its numbers for the committed F1.v2-mom entry (D-1607); the monitors
    // step (M1) writes its quarterly rows into residual_monitor; the announcement step (T2) freezes the plans of its 23
    // lineages (one more than the 24 of the ledger: its plan-only entries are the same rows) and writes one meter row; the
    // steps still stubs write nothing (each task that lands a step moves its own table out of the zero list)
    const own = async (t: string): Promise<number> =>
      Number((await on.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);
    // the committed ledger decides the counts: one plan row per lineage, one look and one result per recorded verdict
    const ledger = JSON.parse(readFileSync(join(__dirname, "../../..", LEDGER_PATH), "utf8")) as {
      entries: { lineage: string; verdict?: string }[];
    };
    expect(await own("research_prereg"), "research_prereg").toBe(
      new Set(ledger.entries.map((e) => e.lineage)).size,
    );
    for (const t of ["research_result", "holdout_look"])
      expect(await own(t), t).toBe(ledger.entries.filter((e) => e.verdict !== undefined).length);
    // the archive of the golden world is empty: T2 writes one meter row, "collecting", and no look of its own; M3 writes the 12
    // live-tested rows (F1 to F6, two lines each), the 6 mover rows and the 3 label rows (no stream cell exists yet): 22 in all
    expect(await own("research_meter"), "research_meter").toBe(22);
    expect(await own("residual_monitor"), "residual_monitor").toBeGreaterThan(0);
    for (const t of M23_OWN.filter(
      (x) =>
        !["research_prereg", "research_result", "residual_monitor", "research_meter"].includes(x),
    )) {
      expect(await own(t), t).toBe(0);
    }
    // a replayed night and a disabled market do not run it either
    expect((await runResearchNight(on, { market: "AU", d, now: TS, replay: true })).status).toBe(
      "skipped_replay",
    );
    expect((await runResearchNight(on, { market: "IN", d, now: TS })).status).toBe(
      "skipped_market",
    );
    // a failing step writes one plain line to app_log (own-set) and nothing else
    const bad: ResearchStep = {
      name: "bad",
      plain: "testing a failure",
      async run() {
        throw new Error("x");
      },
    };
    expect((await runResearchNight(on, { market: "AU", d, now: TS }, [bad])).failed).toEqual([
      "bad",
    ]);
    const after = await complementDump(on);
    expect(after.perTable).toEqual(a.perTable);
  });

  it("rows in the own tables (what the steps write) move no other table", async () => {
    const db = await at32World();
    const before = await complementDump(db);
    for (const w of M23_STEP_WRITERS) await w(db);
    for (const t of M23_OWN) {
      expect(
        Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n),
        t,
      ).toBeGreaterThanOrEqual(1);
    }
    const after = await complementDump(db);
    expect(
      Object.keys(before.perTable).filter((t) => before.perTable[t] !== after.perTable[t]),
    ).toEqual([]);
    expect(after.rows).toEqual(before.rows);
  });

  it("is not vacuous: a row in a hashed table changes exactly that table's hash", async () => {
    const db = await at32World();
    const before = await complementDump(db);
    await db.execute(
      `INSERT INTO expert_poll_run (kind, d, counts_json, created_at) VALUES ('poll', '2030-01-02', '{"n":1}', '${TS}')`,
    );
    const after = await complementDump(db);
    expect(
      Object.keys(before.perTable).filter((t) => before.perTable[t] !== after.perTable[t]),
    ).toEqual(["expert_poll_run"]);
  });
});
