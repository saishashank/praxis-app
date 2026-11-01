// @vitest-environment node
// V1-B1 (D-661): closeBooksDay refuses to run for session D when the previous trading session has
// no closed arena-2a record (a lost night), raises a P1 incident and writes nothing in the books;
// the first night, holidays and a recovery run in order are unaffected.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { closeBooksDay, closeBooksKey, type CloseBooksResult } from "@/lib/arena/closeBooks";
import { cleanupTempDbs } from "../db/helpers";
import { MARKET, NOW, dumpTables, setupReplay } from "./replayHarness";

afterEach(cleanupTempDbs);

const BASE = { startD: "2030-01-07", sessions: 70, seed: 3 };
const closeDay = (db: Client, d: string): Promise<CloseBooksResult> =>
  closeBooksDay(db, { market: MARKET, d, replay: true, now: NOW });
const count = async (db: Client, sql: string, args: string[] = []): Promise<number> =>
  Number((await db.execute({ sql, args })).rows[0].n);

describe("previous session not closed (V1-B1)", () => {
  it("previous day closed: runs", async () => {
    const s = await setupReplay(BASE);
    const [d0, d1, d2] = s.ds.dates;
    expect((await closeDay(s.db, d0)).status).toBe("success");
    expect((await closeDay(s.db, d1)).status).toBe("success");
    expect((await closeDay(s.db, d2)).status).toBe("success");
  });

  it("previous day missing: refuses, failed record, P1 incident, no fill, no nav row", async () => {
    const s = await setupReplay(BASE);
    const d = s.ds.dates;
    for (let i = 0; i <= 2; i++) await closeDay(s.db, d[i]);
    const navBefore = await count(s.db, "SELECT COUNT(*) AS n FROM nav_daily");
    const fillsBefore = await count(s.db, "SELECT COUNT(*) AS n FROM fill");
    const r = await closeDay(s.db, d[4]); // d[3] was lost
    expect(r).toMatchObject({
      status: "failed",
      reason: "previous_session_not_closed",
      closed: [],
    });
    expect(await count(s.db, "SELECT COUNT(*) AS n FROM nav_daily")).toBe(navBefore);
    expect(await count(s.db, "SELECT COUNT(*) AS n FROM fill")).toBe(fillsBefore);
    const run = (
      await s.db.execute({
        sql: "SELECT status, error_summary, details_json FROM run_record WHERE concurrency_key = ?",
        args: [closeBooksKey(MARKET, d[4])],
      })
    ).rows[0];
    expect(String(run.status)).toBe("failed"); // never "skipped": the next night must not read it as closed
    expect(JSON.parse(String(run.details_json))).toEqual({
      reason: "previous_session_not_closed",
      priorD: d[3],
    });
    const inc = await s.db.execute(
      "SELECT severity FROM incident WHERE kind = 'arena_close_gap' AND resolved_at IS NULL",
    );
    expect(inc.rows.map((x) => String(x.severity))).toEqual(["S2"]);
    // a second attempt and the night after: still refused, still one open incident, nothing written
    expect((await closeDay(s.db, d[4])).reason).toBe("previous_session_not_closed");
    expect((await closeDay(s.db, d[5])).reason).toBe("previous_session_not_closed");
    expect(
      await count(s.db, "SELECT COUNT(*) AS n FROM incident WHERE kind = 'arena_close_gap'"),
    ).toBe(1);
    expect(await count(s.db, "SELECT COUNT(*) AS n FROM nav_daily")).toBe(navBefore);
  });

  it("re-run after recovery: the missed night then the next one end identical to an undisturbed run", async () => {
    const a = await setupReplay(BASE);
    const b = await setupReplay(BASE);
    for (let i = 0; i <= 5; i++) await closeDay(a.db, a.ds.dates[i]);
    for (let i = 0; i <= 2; i++) await closeDay(b.db, b.ds.dates[i]);
    expect((await closeDay(b.db, b.ds.dates[4])).status).toBe("failed"); // refused
    expect((await closeDay(b.db, b.ds.dates[3])).status).toBe("success"); // replay of the lost night
    expect((await closeDay(b.db, b.ds.dates[4])).status).toBe("success"); // the refused night, re-run
    expect((await closeDay(b.db, b.ds.dates[5])).status).toBe("success");
    expect(await dumpTables(b.db)).toEqual(await dumpTables(a.db));
  });

  it("the first night (no earlier closed session) is not blocked", async () => {
    const s = await setupReplay(BASE);
    const r = await closeDay(s.db, s.ds.dates[3]);
    expect(r.status).toBe("success");
  });

  it("a market whose only earlier night ended in an invariant freeze is not a first night (D-675)", async () => {
    const s = await setupReplay(BASE);
    const d = s.ds.dates;
    expect((await closeDay(s.db, d[0])).status).toBe("success");
    await s.db.execute({
      sql: "UPDATE run_record SET status = 'failed', error_summary = 'invariants failed for 1 cohort(s)' WHERE concurrency_key = ?",
      args: [closeBooksKey(MARKET, d[0])],
    });
    const r = await closeDay(s.db, d[2]); // d[1] was lost; d[0] is closed (frozen), so no exemption
    expect(r).toMatchObject({ status: "failed", reason: "previous_session_not_closed" });
    expect((await closeDay(s.db, d[1])).status).toBe("success"); // a frozen prior night counts as closed
    expect((await closeDay(s.db, d[2])).status).toBe("success");
  });

  it("a holiday in between is not a gap: the previous TRADING day is checked", async () => {
    const s = await setupReplay(BASE);
    const d = s.ds.dates;
    await s.db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('AU', ?, 'holiday', NULL, 1, 'synthetic')",
      args: [d[2]],
    });
    await closeDay(s.db, d[0]);
    await closeDay(s.db, d[1]);
    expect((await closeDay(s.db, d[2])).reason).toBe("non_trading_day");
    expect((await closeDay(s.db, d[3])).status).toBe("success");
  });

  it("an early-close day is a normal session for the check", async () => {
    const s = await setupReplay(BASE);
    const d = s.ds.dates;
    await closeDay(s.db, d[0]);
    await s.db.execute({
      sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('AU', ?, 'early_close', '14:10', 1, 'synthetic')",
      args: [d[1]],
    });
    expect((await closeDay(s.db, d[2])).reason).toBe("previous_session_not_closed");
    expect((await closeDay(s.db, d[1])).status).toBe("success");
    expect((await closeDay(s.db, d[2])).status).toBe("success");
  });
});
