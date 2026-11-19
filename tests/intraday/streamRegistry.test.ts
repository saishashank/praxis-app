// @vitest-environment node
// M23 M3 (VAL-120, D-1608, D-1723): each intraday-stream cell is its own registry lineage with a frozen plan (the cell's logged
// spec), its look goes through `takeLook` once as well as the ledger cell, and the V2 once-per-cell rule is unchanged.
// Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/data/calendar";
import { getCell, setCellResult } from "@/lib/cortex/store/ledger";
import {
  cellIdOf,
  evaluateIntradayStream,
  MIN_CANDIDATES,
  MIN_SESSIONS,
  quarterCellIdOf,
} from "@/lib/intraday/evaluator";
import { streamLineage } from "@/lib/research/lineages/intradayStream";
import { INTRADAY_FLOOR_CANDIDATES, INTRADAY_FLOOR_SESSIONS } from "@/lib/research/meters/intraday";
import { canonicalJson, sha256Hex } from "@/lib/research/registry";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterAll(cleanupTempDbs);
const M = "AU";

async function addCandidates(db: Client, start: string, ppm: number, tag: string): Promise<void> {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (let i = 0; i < 70; i += 1) {
    const sd = addDays(start, i);
    stmts.push({
      sql:
        "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
        "item_ann_id, item_category, materiality, polarity, move_ppm, gates_json, excess_open_5_ppm) " +
        "VALUES ('AU', ?, ?, 'scan-1030', ?, 'asx', ?, 'earnings', 2, 'positive', 50000, '[]', ?)",
      args: [sd, `${tag}${i}`, `${sd}T00:30:00Z`, `ann-${tag}${i}`, ppm + ((i * 7) % 11) * 500],
    });
  }
  await db.batch(stmts, "write");
}
const count = async (db: Client, sql: string): Promise<number> =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("the stream cell as a registry lineage", () => {
  it("the lineage key of a cell; the meter floors are the evaluator floors", () => {
    expect(streamLineage(cellIdOf(M), M)).toBe("intraday_stream_v1");
    expect(streamLineage(quarterCellIdOf(M, "2030-07-02T00:00:00Z"), M)).toBe(
      "intraday_stream_v1_2030Q3",
    );
    expect(streamLineage("intraday_stream:IN:v1", M)).toBeNull();
    expect(INTRADAY_FLOOR_CANDIDATES).toBe(MIN_CANDIDATES);
    expect(INTRADAY_FLOOR_SESSIONS).toBe(MIN_SESSIONS);
  });

  it("the plan is frozen the first night, before any figure; the look goes through the registry once, with the ledger result", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", 80_000, "A");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
    // night 0: the cell is logged, its plan is frozen, no look
    const cell0 = (await getCell(db, cellIdOf(M)))!;
    const plan = (
      await db.execute(
        "SELECT item, frozen_json, sha FROM research_prereg WHERE lineage = 'intraday_stream_v1'",
      )
    ).rows;
    expect(plan).toHaveLength(1);
    expect(String(plan[0]!.item)).toBe("VAL-118");
    expect(String(plan[0]!.sha)).toBe(sha256Hex(canonicalJson(cell0.spec)));
    expect(JSON.parse(String(plan[0]!.frozen_json)).hypothesis).toContain(
      "Mean 5-session excess return",
    );
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    // the look night
    const e = await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(e.lookRecorded).toBe(true);
    const look = (await db.execute("SELECT lineage, market, verdict, looked_at FROM holdout_look"))
      .rows;
    expect(look).toHaveLength(1);
    expect({ ...look[0] }).toMatchObject({
      lineage: "intraday_stream_v1",
      market: M,
      verdict: "PASS",
    });
    const res = (await db.execute("SELECT n_setups, stats_json FROM research_result")).rows[0]!;
    expect(Number(res.n_setups)).toBe(70);
    const cell = (await getCell(db, cellIdOf(M)))!;
    expect(JSON.parse(String(res.stats_json))).toEqual(cell.result);
    // later nights: no second look, no refusal (the ledger gate stops first)
    await evaluateIntradayStream(db, M, "2030-06-02T00:00:00.000Z");
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(1);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("a failed look is a NULL; the next quarter cell is its own lineage with its own plan and look", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", -80_000, "A");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(
      (await db.execute("SELECT verdict FROM holdout_look WHERE lineage = 'intraday_stream_v1'"))
        .rows[0]!.verdict,
    ).toBe("NULL");
    await addCandidates(db, "2030-07-02", 400_000, "B");
    await evaluateIntradayStream(db, M, "2030-07-02T00:00:00.000Z"); // the new cell is logged and frozen
    expect(await count(db, "SELECT COUNT(*) n FROM research_prereg")).toBe(2);
    await evaluateIntradayStream(db, M, "2030-07-03T00:00:00.000Z");
    const looks = (await db.execute("SELECT lineage, verdict FROM holdout_look ORDER BY lineage"))
      .rows;
    expect(looks.map((r) => `${r.lineage}:${r.verdict}`)).toEqual([
      "intraday_stream_v1:NULL",
      "intraday_stream_v1_2030Q3:PASS",
    ]);
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("a ledger result with no registry look (taken before the registry) is entered once with its recorded result and date", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", 80_000, "A");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
    await setCellResult(db, cellIdOf(M), "2030-06-01T00:00:00.000Z", {
      passed: true,
      candidates: 70,
      sessions: 70,
      meanNetPpm: 1,
      lowerPpm: 1,
    });
    await evaluateIntradayStream(db, M, "2030-06-02T00:00:00.000Z");
    await evaluateIntradayStream(db, M, "2030-06-03T00:00:00.000Z");
    const look = (await db.execute("SELECT verdict, looked_at FROM holdout_look")).rows;
    expect(look).toHaveLength(1);
    expect(String(look[0]!.verdict)).toBe("PASS");
    expect(String(look[0]!.looked_at)).toBe("2030-06-01T00:00:00.000Z");
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look_refusal")).toBe(0);
  });

  it("below the sample nothing is written to the registry", async () => {
    const db = await freshDb("main");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(await count(db, "SELECT COUNT(*) n FROM holdout_look")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) n FROM research_result")).toBe(0);
  });
});
