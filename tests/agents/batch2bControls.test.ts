// @vitest-environment node
// Batch 2b honours arena_control (D-094): the Owner pause and the ARN-093 kill-switch trip stop NEW
// entries / sleeve openings / control draws of the cohorts they cover, never exits (reduce risk).
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { signalsDay } from "@/lib/agents/batch2b";
import { controlStates, effectiveControl } from "@/lib/agents/controls";
import { cleanupTempDbs } from "../db/helpers";
import {
  MARKET,
  NOW,
  DATES,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden, D } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const params = testParams();
const d = (i: number): string => DATES[i]!;
const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];

type Row = Record<string, unknown>;
type Ctl = readonly [scope: string, key: string, state: string];
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

async function control(db: Client, list: readonly Ctl[]): Promise<void> {
  for (const [scope, key, state] of list) {
    await db.execute({
      sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
            VALUES (?, ?, ?, '2031-01-01T00:00:00.000Z', 'owner', 'test')`,
      args: [scope, key, state],
    });
  }
}

/** A fresh golden world with controls in place; nights 295..to (default the decision night). */
async function world(list: readonly Ctl[], to: number = D): Promise<Client> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, 295, KEEP);
  await control(db, list);
  await runNights(db, params, 295, to);
  return db;
}

/** Executions that placed an entry order (pending / filled / rejected) decided on a day. */
async function ordering(db: Client, day: number = D): Promise<string[]> {
  const rs = await rows(
    db,
    `SELECT DISTINCT c.execution_id FROM arena_order o JOIN cohort c ON c.id = o.cohort_id
     WHERE o.kind = 'entry' AND o.decided_d = ? ORDER BY 1`,
    [d(day)],
  );
  return rs.map((r) => String(r.execution_id));
}

async function cardReasons(db: Client, day: number = D): Promise<string[]> {
  const rs = await rows(
    db,
    `SELECT c.execution_id, s.code, c.taken, c.not_taken_reason FROM decision_card c
     JOIN signal s ON s.id = c.signal_id WHERE s.d = ? ORDER BY 1, 2`,
    [d(day)],
  );
  return rs.map((r) => `${r.execution_id}:${r.code}:${r.taken}:${r.not_taken_reason}`);
}

async function selections(db: Client, day: number = D): Promise<string[]> {
  const rs = await rows(
    db,
    "SELECT cohort_id, skipped, skip_reason FROM c2_selection WHERE d = ? ORDER BY cohort_id",
    [d(day)],
  );
  return rs.map((r) => `${String(r.cohort_id).split("@")[0]}:${r.skipped}:${r.skip_reason}`);
}

afterAll(cleanupTempDbs);

describe("controlStates / effectiveControl (pure)", () => {
  it("latest row wins within a scope; killed is sticky until a later enabled", () => {
    const row = (state: string) => ({ scope: "family", scopeKey: "F4", state });
    const get = (rs: string[]) =>
      effectiveControl(controlStates(rs.map(row)), {
        market: "AU",
        family: "F4",
        execution: "E07",
      });
    expect(get(["paused", "enabled"])).toBe("enabled");
    expect(get(["enabled", "paused"])).toBe("paused");
    expect(get(["killed", "paused"])).toBe("killed");
    expect(get(["killed", "paused", "enabled"])).toBe("enabled");
    expect(get(["killed", "enabled", "paused"])).toBe("paused");
    expect(get([])).toBe("enabled");
  });

  it("execution > family > market", () => {
    const s = controlStates([
      { scope: "market", scopeKey: "AU", state: "killed" },
      { scope: "family", scopeKey: "F4", state: "paused" },
      { scope: "execution", scopeKey: "E07", state: "enabled" },
    ]);
    const at = (family: string | null, execution: string) =>
      effectiveControl(s, { market: "AU", family, execution });
    expect(at("F4", "E07")).toBe("enabled");
    expect(at("F4", "E08")).toBe("paused");
    expect(at("F1", "E01")).toBe("killed");
  });
});

describe("batch 2b under arena_control", () => {
  it("baseline: nothing paused, F1 and F4 enter and the controls draw", async () => {
    const db = await world([]);
    expect(await ordering(db)).toEqual(["C2-F1", "C2-F4", "C3-F4", "E01", "E07", "E08"]);
  });

  it("market pause: no entry, no control draw; cards say control_paused; run record counts it", async () => {
    const db = await world([["market", MARKET, "paused"]]);
    expect(await ordering(db)).toEqual([]);
    expect(await selections(db)).toEqual([]);
    expect(await cardReasons(db)).toEqual([
      "E01:ZZUP:0:control_paused",
      "E07:ZZD1:0:control_paused",
      "E07:ZZD2:0:control_paused",
      "E08:ZZD1:0:control_paused",
      "E08:ZZD2:0:control_paused",
    ]);
    const [rr] = await rows(
      db,
      "SELECT status, details_json AS details FROM run_record WHERE concurrency_key = ?",
      [`arena-2b:${MARKET}:${d(D)}`],
    );
    expect(rr!.status).toBe("success");
    const details = JSON.parse(String(rr!.details)) as Record<string, number>;
    expect(details.controlPaused).toBeGreaterThanOrEqual(3);
    expect(details.controlKilled).toBe(0);
    expect(details.controlSkips).toBe(5);
  });

  it("family pause stops that family and the controls matched to it only", async () => {
    const db = await world([["family", "F4", "paused"]]);
    expect(await ordering(db)).toEqual(["C2-F1", "E01"]);
    expect(await selections(db)).toEqual(["C2-F1#01:0:null"]);
    const reasons = await cardReasons(db);
    expect(reasons).toContain("E01:ZZUP:1:null");
    expect(reasons).toContain("E07:ZZD1:0:control_paused");
  });

  it("execution pause stops one execution; its twin is untouched", async () => {
    const db = await world([["execution", "E07", "paused"]]);
    expect(await ordering(db)).toEqual(["C2-F1", "C2-F4", "C3-F4", "E01", "E08"]);
    const reasons = await cardReasons(db);
    expect(reasons).toContain("E07:ZZD1:0:control_paused");
    expect(reasons).toContain("E08:ZZD1:1:null");
  });

  it("a paused control cohort skips its draws (recorded) while its sibling still draws", async () => {
    const db = await world([["execution", "C2-F4", "paused"]]);
    expect(await selections(db)).toEqual([
      "C2-F1#01:0:null",
      "C2-F4#01:1:control_paused",
      "C3-F4#01:0:null",
    ]);
    expect(await ordering(db)).toEqual(["C2-F1", "C3-F4", "E01", "E07", "E08"]);
  });

  it("precedence: execution enabled beats a family kill, which beats a market pause", async () => {
    const db = await world([
      ["market", MARKET, "paused"],
      ["family", "F4", "killed"],
      ["execution", "E07", "enabled"],
    ]);
    // E07 trades although F4 is killed and the market paused; E08 (same family) is killed; E01 paused
    expect(await ordering(db)).toEqual(["E07"]);
    const reasons = await cardReasons(db);
    expect(reasons).toContain("E07:ZZD1:1:null");
    expect(reasons).toContain("E08:ZZD1:0:control_killed");
    expect(reasons).toContain("E01:ZZUP:0:control_paused");
    // E07 was taken, so its F4 controls are asked and stopped by their own (family) state
    expect(await selections(db)).toEqual([
      "C2-F4#01:1:control_killed",
      "C3-F4#01:1:control_killed",
    ]);
  });

  it("kill is sticky against a later pause, and a later enabled lifts it", async () => {
    const killed = await world([
      ["family", "F4", "killed"],
      ["family", "F4", "paused"],
    ]);
    expect(await cardReasons(killed)).toContain("E07:ZZD1:0:control_killed");
    expect(await ordering(killed)).toEqual(["C2-F1", "E01"]);
    const lifted = await world([
      ["family", "F4", "killed"],
      ["family", "F4", "paused"],
      ["family", "F4", "enabled"],
    ]);
    expect(await ordering(lifted)).toEqual(["C2-F1", "C2-F4", "C3-F4", "E01", "E07", "E08"]);
  });

  it("exits, stops and CS exits continue while paused; only new entries stop", async () => {
    const db = await world([], 301); // ZZD1 bought on D, filled on D+1; its CS exit is decided on 302
    await control(db, [["market", MARKET, "paused"]]);
    await runNights(db, params, 302, 322);
    // no new entry (the unpaused run enters ZZD3 on 303 and ZZUP on 311) ...
    expect(
      await rows(db, "SELECT 1 FROM arena_order WHERE kind = 'entry' AND decided_d >= ?", [d(302)]),
    ).toEqual([]);
    expect(await cardReasons(db, 303)).toContain("E07:ZZD3:0:control_paused");
    // ... while the open ZZD1 position still gets its stop levels and CS exit, which fills
    const exits = await rows(
      db,
      `SELECT o.code, o.decided_d, o.status FROM arena_order o JOIN cohort c ON c.id = o.cohort_id
       WHERE c.execution_id = 'E07' AND o.kind = 'exit_cs'`,
    );
    expect(exits.map((e) => `${e.code}:${e.decided_d}:${e.status}`)).toEqual([
      `ZZD1:${d(302)}:filled`,
    ]);
    expect(
      (
        await rows(
          db,
          `SELECT 1 FROM trade t JOIN cohort c ON c.id = t.cohort_id
           WHERE t.exit_type = 'CS' AND t.code = 'ZZD1' AND c.execution_id = 'E07'`,
        )
      ).length,
    ).toBe(1);
    expect(
      (await rows(db, "SELECT 1 FROM stop_level WHERE d = ?", [d(302)])).length,
    ).toBeGreaterThan(0);
  });

  it("a paused market still closes a position entered before the pause (E07 ZZUP, exit on 315)", async () => {
    const db = await world([], 313);
    await control(db, [["market", MARKET, "paused"]]);
    await runNights(db, params, 314, 322);
    const exits = await rows(
      db,
      `SELECT o.code, o.decided_d, o.status FROM arena_order o JOIN cohort c ON c.id = o.cohort_id
       WHERE c.execution_id = 'E07' AND o.kind = 'exit_cs' AND o.decided_d >= '${d(314)}'`,
    );
    expect(exits.map((e) => `${e.code}:${e.decided_d}:${e.status}`)).toEqual([
      `ZZUP:${d(315)}:filled`,
    ]);
  });

  it("an idempotent rerun writes nothing new, paused or not", async () => {
    const db = await world([["family", "F4", "paused"]]);
    const count = async (): Promise<string> =>
      JSON.stringify(
        await rows(
          db,
          `SELECT (SELECT COUNT(*) FROM arena_order) o, (SELECT COUNT(*) FROM decision_card) c,
                  (SELECT COUNT(*) FROM c2_selection) s, (SELECT COUNT(*) FROM signal) g,
                  (SELECT COUNT(*) FROM run_record) r`,
        ).then((r) =>
          r.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, String(v)]))),
        ),
      );
    const before = await count();
    const again = await signalsDay(db, {
      market: MARKET,
      d: d(D),
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
    expect(await count()).toBe(before);
  });
});
