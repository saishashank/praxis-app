// @vitest-environment node
// CXA-010 monitor 6 (M23 M2; D-1620, D-1701): the record row, and the revisit alarm that fires once, on the first night
// a live-tested statement exists.
import { afterAll, describe, expect, it } from "vitest";
import {
  LENS_OPTION,
  REVISIT_PERIOD,
  REVISIT_TEXT,
  lensDef,
  lensMonitor,
} from "@/lib/cortex/monitors/lens";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);

describe("monitor 6: the record", () => {
  it("carries the chosen option, its reason and the counts; no alarm on a quarterly row", () => {
    const r = lensMonitor({ max: 0.4, vetoed: 7, abstainNights: 2 }, false);
    expect(r.alarm).toBe(false);
    expect(r.ownerItems).toEqual([]);
    expect(r.value).toMatchObject({
      option: LENS_OPTION,
      disagreement_max: 0.4,
      g10_vetoed: 7,
      g10_abstain_nights: 2,
      revisit: false,
    });
    expect(String(r.value.reason).length).toBeGreaterThan(20);
  });

  it("the revisit row alarms with the plain sentence", () => {
    const r = lensMonitor({ max: 0.4, vetoed: 0, abstainNights: 0 }, true);
    expect(r.alarm).toBe(true);
    expect(r.ownerItems).toEqual([REVISIT_TEXT]);
    expect(REVISIT_TEXT).not.toMatch(/\b(G10|CXA|D-\d)\b/);
  });
});

describe("monitor 6: the period (on a real database)", () => {
  async function market(db: Awaited<ReturnType<typeof freshDb>>): Promise<string> {
    return String(
      (await db.execute("SELECT code FROM market WHERE enabled = 1 ORDER BY code LIMIT 1")).rows[0]!
        .code,
    );
  }
  const statement = (m: string, at: string): string =>
    `INSERT INTO cortex_statement (statement_id, market, family, kind, text, numbers_json, created_at) VALUES ('s1', '${m}', 'F1', 'live_tested', 't', '{}', '${at}')`;

  it("no statement: the quarter before; a statement the night before: the one-off revisit period", async () => {
    const db = await freshDb("main");
    const m = await market(db);
    expect(await lensDef.period(db, m, "2030-05-15")).toBe("2030-Q1");
    await db.execute(statement(m, "2030-05-15T01:00:00Z"));
    expect(await lensDef.period(db, m, "2030-05-14")).toBe("2030-Q1");
    expect(await lensDef.period(db, m, "2030-05-15")).toBe(REVISIT_PERIOD);
  });

  it("once the revisit row is stored the period goes back to the quarter (it fires once)", async () => {
    const db = await freshDb("main");
    const m = await market(db);
    await db.execute(statement(m, "2030-05-15T01:00:00Z"));
    await db.execute({
      sql: "INSERT INTO residual_monitor (market, monitor, period, value_json, alarm, created_at) VALUES (?, 6, ?, '{}', 1, '2030-05-15T08:00:00Z')",
      args: [m, REVISIT_PERIOD],
    });
    expect(await lensDef.period(db, m, "2030-05-16")).toBe("2030-Q1");
  });
});
