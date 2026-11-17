// @vitest-environment node
// The intraday-stream meter (M23 M3; VAL-120, D-1723): one row a night for the active cell, n the smaller of the measured
// candidates and their sessions against 60, `looked` once the cell holds its look, nothing while no cell exists.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "@/lib/data/calendar";
import { evaluateIntradayStream } from "@/lib/intraday/evaluator";
import { runIntradayMeter } from "@/lib/research/meters/intraday";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);
const M = "AU";
const at = (d: string) => ({ market: M, d, now: `${d}T12:00:00Z` });

async function candidates(
  db: Client,
  start: string,
  count: number,
  sessions: number,
): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) => {
    const sd = addDays(start, i % sessions);
    return {
      sql:
        "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
        "item_ann_id, item_category, materiality, polarity, move_ppm, gates_json, excess_open_5_ppm) " +
        "VALUES ('AU', ?, ?, 'scan-1030', ?, 'asx', ?, 'earnings', 2, 'positive', 0, '[]', 1000)",
      args: [sd, `Z${i}-${start}`, `${sd}T00:30:00Z`, `a${i}-${start}`],
    };
  });
  await db.batch(rows, "write");
}

describe("runIntradayMeter", () => {
  it("writes nothing while the stream has no cell", async () => {
    const db = await freshDb("main");
    expect(await runIntradayMeter(db, at("2030-06-01"))).toBeNull();
    expect((await db.execute("SELECT COUNT(*) n FROM research_meter")).rows[0]!.n).toBe(0);
  });

  it("n is the smaller of candidates and sessions: 200 candidates on 59 sessions is 59, on 60 it is met", async () => {
    const db = await freshDb("main");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z"); // logs the cell
    await candidates(db, "2030-01-01", 200, 59);
    const a = await runIntradayMeter(db, at("2030-06-01"));
    expect(a).toEqual({ lineage: "intraday_stream_v1", n: 59, status: "collecting" });
    await candidates(db, "2031-01-01", 1, 1); // a 60th session
    const b = await runIntradayMeter(db, at("2030-06-02"));
    expect(b).toMatchObject({ n: 60, status: "met" });
    const rows = (await db.execute("SELECT d, n, target, status FROM research_meter ORDER BY d"))
      .rows;
    expect(rows.map((r) => `${r.d}:${r.n}/${r.target}:${r.status}`)).toEqual([
      "2030-06-01:59/60:collecting",
      "2030-06-02:60/60:met",
    ]);
  });

  it("is looked once the cell holds its result", async () => {
    const db = await freshDb("main");
    await evaluateIntradayStream(db, M, "2030-05-31T00:00:00.000Z");
    await candidates(db, "2030-01-01", 70, 70);
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(await runIntradayMeter(db, at("2030-06-02"))).toMatchObject({ status: "looked" });
  });
});
