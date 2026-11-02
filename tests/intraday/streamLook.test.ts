// @vitest-environment node
// V2-B2 (D-670..D-674): the VAL-118 look is taken ONCE per cell and the stream state follows the
// recorded result, not the figures of the latest night. Synthetic ZZ data only (SEC-110).
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config/store";
import { addDays } from "@/lib/data/calendar";
import { cellsOfKind, getCell, setCellResult } from "@/lib/cortex/store/ledger";
import {
  activeStreamCell,
  cellIdOf,
  evaluateIntradayStream,
  quarterCellIdOf,
} from "@/lib/intraday/evaluator";
import { loadAlertsReport } from "@/lib/ui/loaders/alertsReport";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterAll(cleanupTempDbs);
const M = "AU";

/** 70 measured candidates from `start`, one per session; excess is `ppm` plus a little noise. */
async function addCandidates(db: Client, start: string, ppm: number, tag: string): Promise<void> {
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (let i = 0; i < 70; i += 1) {
    const sd = addDays(start, i);
    stmts.push({
      sql:
        "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
        "item_ann_id, item_category, materiality, polarity, move_ppm, gates_json, excess_open_5_ppm) " +
        "VALUES ('AU', ?, ?, 'scan-1030', ?, 'asx', ?, 'earnings', 2, 'positive', 0, '[]', ?)",
      args: [sd, `${tag}${i}`, `${sd}T00:30:00Z`, `ann-${tag}${i}`, ppm + ((i * 7) % 11) * 500],
    });
  }
  await db.batch(stmts, "write");
}

/** Night 0: logs the pre-registered cell (a cell is logged before its result, so no look yet). */
const prime = async (db: Client) => {
  const e = await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
  expect(e.lookRecorded).toBe(false);
  expect(await state(db)).toBe("shadow");
};

const state = (db: Client) => getConfig(db, "intraday_stream_state");

describe("V2-B2: one look per cell, state bound to the recorded result", () => {
  it("(a) the first qualifying night records the look and sets the state", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", 80_000, "A");
    await prime(db);
    expect(await state(db)).toBe("shadow");
    const e = await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(e.lookRecorded).toBe(true);
    expect(e.changed).toBe(true);
    expect(e.state).toBe("allowed");
    expect(await state(db)).toBe("allowed");
    const cell = await getCell(db, cellIdOf(M));
    expect((cell!.result as { passed: boolean }).passed).toBe(true);
  });

  it("(b) later nights with the opposite outcome change nothing (fail then pass, pass then fail)", async () => {
    const f = await freshDb("main");
    await addCandidates(f, "2030-01-01", -80_000, "A");
    await prime(f);
    const f1 = await evaluateIntradayStream(f, M, "2030-06-01T00:00:00.000Z");
    expect(f1.lookRecorded).toBe(true);
    expect(f1.state).toBe("shadow");
    await addCandidates(f, "2030-03-15", 400_000, "B"); // a later night would now pass a fresh test
    const f2 = await evaluateIntradayStream(f, M, "2030-06-02T00:00:00.000Z");
    expect(f2.lowerPpm!).toBeGreaterThan(0); // descriptive figure moves...
    expect(f2.lookRecorded).toBe(false);
    expect(f2.changed).toBe(false);
    expect(await state(f)).toBe("shadow"); // ...the state does not
    expect(((await getCell(f, cellIdOf(M)))!.result as { passed: boolean }).passed).toBe(false);

    const p = await freshDb("main");
    await addCandidates(p, "2030-01-01", 80_000, "A");
    await prime(p);
    await evaluateIntradayStream(p, M, "2030-06-01T00:00:00.000Z");
    await addCandidates(p, "2030-03-15", -900_000, "B");
    const p2 = await evaluateIntradayStream(p, M, "2030-06-02T00:00:00.000Z");
    expect(p2.lowerPpm === null || p2.lowerPpm <= 0).toBe(true);
    expect(p2.changed).toBe(false);
    expect(await state(p)).toBe("allowed");
    const rows = await p.execute(
      "SELECT count(*) AS n FROM config_version WHERE key = 'intraday_stream_state'",
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  it("an Owner demotion to shadow is not undone by later nights", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", 80_000, "A");
    await prime(db);
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    const { ownerSetShadow } = await import("@/lib/intraday/evaluator");
    expect(await ownerSetShadow(db, 1, "2030-06-02T00:00:00.000Z")).toBe(true);
    await evaluateIntradayStream(db, M, "2030-06-03T00:00:00.000Z");
    await evaluateIntradayStream(db, M, "2030-06-04T00:00:00.000Z");
    expect(await state(db)).toBe("shadow");
  });

  it("applies a recorded look whose state write was lost, once (idempotent reconcile)", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", 80_000, "A");
    await prime(db);
    // simulate the crash: the look was recorded, the state write never happened
    await setCellResult(db, cellIdOf(M), "2030-06-01T00:00:00.000Z", {
      passed: true,
      candidates: 70,
      sessions: 70,
      meanNetPpm: 1,
      lowerPpm: 1,
    });
    expect(await state(db)).toBe("shadow");
    const e = await evaluateIntradayStream(db, M, "2030-06-02T00:00:00.000Z");
    expect(e.lookRecorded).toBe(false);
    expect(e.changed).toBe(true);
    expect(await state(db)).toBe("allowed");
    const again = await evaluateIntradayStream(db, M, "2030-06-03T00:00:00.000Z");
    expect(again.changed).toBe(false);
  });

  it("(c) a new quarter after a failed look logs ONE new charged cell and takes one new look", async () => {
    const db = await freshDb("main");
    await addCandidates(db, "2030-01-01", -80_000, "A");
    await prime(db);
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z"); // Q2: look 1 fails
    // same quarter: no new cell, whatever the data
    await addCandidates(db, "2030-07-02", 400_000, "B");
    await evaluateIntradayStream(db, M, "2030-06-20T00:00:00.000Z");
    expect(await cellsOfKind(db, M, "all", "intraday_stream")).toHaveLength(1);
    // new quarter: the cell is logged, its look comes on a later night, on sessions from its date
    const q = "2030-07-02T00:00:00.000Z";
    const n1 = await evaluateIntradayStream(db, M, q);
    expect(n1.cellId).toBe(quarterCellIdOf(M, q));
    expect(n1.lookRecorded).toBe(false);
    expect(await state(db)).toBe("shadow");
    const n2 = await evaluateIntradayStream(db, M, "2030-07-03T00:00:00.000Z");
    expect(n2.lookRecorded).toBe(true);
    expect(n2.candidates).toBe(70); // only the new cell's sessions, not the failed ones
    expect(await state(db)).toBe("allowed");
    expect(await cellsOfKind(db, M, "all", "intraday_stream")).toHaveLength(2);
    // a passed cell gets no successor, even a quarter later
    const n3 = await evaluateIntradayStream(db, M, "2030-10-05T00:00:00.000Z");
    expect(n3.lookRecorded).toBe(false);
    expect(await cellsOfKind(db, M, "all", "intraday_stream")).toHaveLength(2);
    expect(await state(db)).toBe("allowed");
    // the alerts report shows the recorded (latest) cell
    const rep = await loadAlertsReport(db, M);
    expect(rep.verdict).toBe("passed");
    expect((await activeStreamCell(db, M))!.cellId).toBe(quarterCellIdOf(M, q));
  });
});
