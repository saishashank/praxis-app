// @vitest-environment node
// AT-63 (M17 WP9; VAL-118, VAL-119, D-391, D-462..D-467): the nightly measurement of intraday
// candidates on a synthetic ZZ set, the pre-registered lineage row, the evaluator (a null set stays
// shadow, a planted +1.5 % set passes), the monthly report, and the single writer of the state key.
// Synthetic ZZ data only (SEC-110).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { getConfig, setConfig } from "@/lib/config/store";
import { addDays } from "@/lib/data/calendar";
import { getCell } from "@/lib/cortex/store/ledger";
import {
  cellIdOf,
  evaluateIntradayStream,
  HYPOTHESIS_TEXT,
  ownerSetShadow,
} from "@/lib/intraday/evaluator";
import { measureCandidates } from "@/lib/intraday/measure";
import { loadAlertsReport } from "@/lib/ui/loaders/alertsReport";
import { alertsReportView, pctText } from "@/app/(app)/reviews/alerts/view";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);
const M = "AU";
const START = "2030-01-01";
const SESSIONS = 70;

/** 70 session days, one candidate each; its code ZZn has bars on the 6 days around its session. */
async function seed(meanExcess: number): Promise<{ db: Client; last: string }> {
  const db = await freshDb("main");
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (let k = -1; k < SESSIONS + 10; k += 1) {
    const d = addDays(START, k);
    stmts.push({
      sql: "INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at) VALUES ('AU','AXJO',?,100000000,100000000,100000000,100000000,'yahoo_index',?,?)",
      args: [d, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
    });
  }
  for (let i = 0; i < SESSIONS; i += 1) {
    const sd = addDays(START, i);
    const code = `ZZ${i}`;
    stmts.push({
      sql:
        "INSERT INTO intraday_candidate (market, session_d, code, found_slot, found_at, item_source, " +
        "item_ann_id, item_category, materiality, polarity, move_ppm, gates_json) " +
        "VALUES ('AU', ?, ?, 'scan-1030', ?, 'asx', ?, 'earnings', 2, 'positive', 0, '[]')",
      args: [sd, code, `${sd}T00:30:00Z`, `ann-${code}`],
    });
    const noise = ((i * 7) % 11) - 5; // -5..5 tenths of a percent, mean 0
    for (let k = 0; k <= 5; k += 1) {
      const d = addDays(sd, k === 0 ? -1 : k);
      const close = k === 0 ? 100 : 100 * (1 + (meanExcess * k) / 5 + noise / 1000);
      stmts.push({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, 100, 101, 99, ?, 1000, 'yahoo_eod', ?, ?)`,
        args: [code, d, close, `${d}T07:00:00.000Z`, `${d}T07:00:00.000Z`],
      });
    }
  }
  await db.batch(stmts, "write");
  return { db, last: addDays(START, SESSIONS + 8) };
}

describe("AT-63 (a) nightly measurement", () => {
  it("fills the 1, 3 and 5-session excess columns once, and a second run writes nothing", async () => {
    const { db, last } = await seed(0.015);
    const r1 = await measureCandidates(db, M, last);
    expect(r1.updated).toBe(SESSIONS);
    const row = (
      await db.execute(
        "SELECT * FROM intraday_candidate WHERE code = 'ZZ5' AND session_d = '2030-01-06'",
      )
    ).rows[0]!;
    // ZZ5: noise (35 % 11) - 5 = -3 -> -0.3 %; close_5 = 100 * (1 + 0.015 - 0.003); index flat
    expect(Number(row.excess_open_5_ppm)).toBe(12_000);
    expect(Number(row.excess_open_1_ppm)).toBe(0);
    expect(Number(row.excess_found_5_ppm)).toBe(12_000);
    expect(row.measured_at).not.toBeNull();
    const again = await measureCandidates(db, M, last);
    expect(again.updated).toBe(0);
  });

  it("measures nothing before the horizon has completed", async () => {
    const { db } = await seed(0.015);
    const r = await measureCandidates(db, M, addDays(START, 2));
    expect(r.updated).toBeGreaterThan(0);
    const open5 = await db.execute(
      "SELECT count(*) AS n FROM intraday_candidate WHERE excess_open_5_ppm IS NOT NULL",
    );
    expect(Number(open5.rows[0]!.n)).toBe(0);
  });
});

describe("AT-63 (b)(c) lineage row, null set fails, +1.5 % passes", () => {
  it("a null set stays shadow; the hypothesis row is logged and the result recorded once", async () => {
    const { db, last } = await seed(0);
    await measureCandidates(db, M, last);
    const e1 = await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(e1.sampleMet).toBe(true);
    const cell = await getCell(db, cellIdOf(M));
    expect(cell).not.toBeNull();
    expect(cell!.kind).toBe("intraday_stream");
    expect(cell!.family).toBe("all");
    expect((cell!.spec as { hypothesis: string }).hypothesis).toBe(HYPOTHESIS_TEXT);
    const e2 = await evaluateIntradayStream(db, M, "2030-06-02T00:00:00.000Z");
    expect(e2.state).toBe("shadow");
    expect(e2.lowerPpm).not.toBeNull();
    expect(e2.lowerPpm!).toBeLessThanOrEqual(0);
    expect(await getConfig(db, "intraday_stream_state")).toBe("shadow");
    const done = await getCell(db, cellIdOf(M));
    expect((done!.result as { passed: boolean }).passed).toBe(false);
    const n = await db.execute(
      "SELECT count(*) AS n FROM cortex_ledger_cell WHERE kind = 'intraday_stream'",
    );
    expect(Number(n.rows[0]!.n)).toBe(1);
  });

  it("a planted +1.5 % set passes and becomes allowed; the Owner can only set shadow", async () => {
    const { db, last } = await seed(0.015);
    await measureCandidates(db, M, last);
    await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    const e = await evaluateIntradayStream(db, M, "2030-06-02T00:00:00.000Z");
    expect(e.lowerPpm!).toBeGreaterThan(0);
    expect(e.state).toBe("allowed");
    expect(await getConfig(db, "intraday_stream_state")).toBe("allowed");
    expect(((await getCell(db, cellIdOf(M)))!.result as { passed: boolean }).passed).toBe(true);
    // no UI or API route: setConfig refuses the fixed key
    await expect(
      setConfig(db, {
        key: "intraday_stream_state",
        value: "allowed",
        userId: 1,
        now: "2030-06-03T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect(await ownerSetShadow(db, 1, "2030-06-03T00:00:00.000Z")).toBe(true);
    expect(await getConfig(db, "intraday_stream_state")).toBe("shadow");
  });

  it("a short sample never passes", async () => {
    const { db } = await seed(0.05);
    await measureCandidates(db, M, addDays(START, 20));
    const e = await evaluateIntradayStream(db, M, "2030-06-01T00:00:00.000Z");
    expect(e.sampleMet).toBe(false);
    expect(e.state).toBe("shadow");
  });
});

describe("AT-63 (d) monthly report", () => {
  it("renders the empty state and the measured months, all labelled shadow", async () => {
    const empty = await freshDb("main");
    const none = alertsReportView(await loadAlertsReport(empty, M));
    expect(none.months).toEqual([]);
    expect(none.banner).toContain("shadow");
    expect(none.verdictText).toContain("Not proven yet");
    const { db, last } = await seed(0.015);
    await measureCandidates(db, M, last);
    const v = alertsReportView(await loadAlertsReport(db, M));
    expect(v.months[0]!.found).toBeGreaterThan(0);
    expect(v.months.reduce((a, m) => a + m.measured, 0)).toBe(SESSIONS);
    expect(v.progressText).toContain("70 sessions");
    expect(pctText(15_000)).toBe("+1.50 % (shadow, unvalidated)");
    expect(pctText(null)).toBe("Not measured yet");
    const page = readFileSync(
      path.resolve(import.meta.dirname, "../../../src/app/(app)/reviews/alerts/page.tsx"),
      "utf8",
    );
    expect(page).toContain("No data yet");
    expect(page).toContain("unvalidated");
  });
});

describe("AT-63 static: the single writer of intraday_stream_state (D-391)", () => {
  it("only the evaluator, through streamState.ts, writes the key", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const walk = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
      );
    const writers = walk("src")
      .filter((f) => /\.(ts|tsx|mjs)$/.test(f))
      .filter((f) =>
        /writeStreamState|VALUES \('intraday_stream_state'|key:\s*["']intraday_stream_state["']/.test(
          readFileSync(path.join(root, f), "utf8"),
        ),
      )
      .map((f) => f.replaceAll("\\", "/"));
    expect(writers.sort()).toEqual([
      "src/lib/config/streamState.ts",
      "src/lib/intraday/evaluator.ts",
    ]);
  });
});
