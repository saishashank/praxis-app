// AT-68 (a), M19 E2 (MKT-110 a, D-996, D-1048, D-1079): the Worker half of "no job for a market that is not enabled",
// proven on the production shape (the migration seed: AU enabled, IN and US built and off). The rest of AT-68 is
// tests/acceptance/v3/at68.test.ts (root suite, same CI run); this file lives here because the Worker's SQLite double
// (fakeTurso) is typed by the Worker package.
//   - the clock under the seed dispatches AU jobs and never names IN or US, in the run key, the dispatch inputs or the
//     rollup; a market row with enabled 0 is invisible to it;
//   - runNow refuses IN, US and an unknown code with `market_not_enabled` before any other gate, dispatching nothing;
//     AU is not refused.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClockCache, runClock, type ClockEnv } from "../src/clock";
import { runRunNow, type RunNowEnv } from "../src/runNow";
import { slotTable } from "../src/schedule";
import { parseMarketRows } from "../src/markets";
import { AU_ROW, IN_ROW } from "./auRow";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv & RunNowEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  APP_BASE_URL: "https://praxis-app.example.test",
  WORKER_HMAC_SECRET: "7".repeat(64),
};
const MON = "2026-06-15"; // AEST Monday, a seeded AU session day
const at = (date: string, hm: string, offset = 10) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  db.prepare(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
  ).run();
});
afterEach(() => vi.restoreAllMocks());

describe("AT-68 (a) the Worker clock under the production shape", () => {
  it("the seed is AU enabled, IN and US built and off; the table the Worker builds names AU only", () => {
    expect(rows(db, "SELECT code, enabled, mode FROM market ORDER BY code")).toEqual([
      { code: "AU", enabled: 1, mode: "data_only" },
      { code: "IN", enabled: 0, mode: "off" },
      { code: "US", enabled: 0, mode: "off" },
    ]);
    const built = slotTable(
      parseMarketRows(
        rows(
          db,
          "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json FROM market WHERE enabled = 1",
        ).map((r) => Object.values(r) as never),
      ),
    );
    expect(built.skipped).toEqual([]);
    expect(JSON.stringify(built.slots)).not.toMatch(/:(IN|US)[:"]/);
    expect(JSON.stringify(slotTable([AU_ROW]).slots)).toBe(JSON.stringify(built.slots));
    expect(
      slotTable(
        parseMarketRows([
          ["IN", IN_ROW.tz, "09:15", "15:30", "17:30", "INR", "off", 0, IN_ROW.slots_json],
        ]),
      ).slots,
    ).toEqual([]);
  });

  it("a night of ticks dispatches AU jobs only: no run key, record or input names IN or US", async () => {
    for (const hm of ["17:30", "17:50", "18:10", "22:30"]) {
      await runClock(ENV, at(MON, hm), { fetch: net.f, nowMs: () => at(MON, hm) });
    }
    expect(net.github.length).toBeGreaterThan(0);
    for (const c of net.github) expect(c.body).not.toMatch(/"market":\s*"(IN|US)"/);
    const keys = rows(db, "SELECT concurrency_key, market FROM run_record").map(
      (r) => `${String(r.concurrency_key)}|${String(r.market)}`,
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).not.toMatch(/(^|[:|])(IN|US)([:|]|$)/);
    expect(
      rows(db, "SELECT COUNT(*) AS n FROM run_record WHERE market IN ('IN', 'US')")[0],
    ).toEqual({ n: 0 });
  });
});

describe("AT-68 (a) runNow", () => {
  const T0 = Date.UTC(2026, 9, 18, 16, 0);
  const add = (market: string) =>
    Number(
      (
        db
          .prepare(
            "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, audit_ref, status, updated_at) " +
              "VALUES ('ingest-batch1', ?, '{}', ?, ?, 'audit:1', 'pending', ?)",
          )
          .run(
            market,
            "a".repeat(64),
            new Date(T0 - 60_000).toISOString(),
            new Date(T0 - 60_000).toISOString(),
          ) as unknown as { lastInsertRowid: number | bigint }
      ).lastInsertRowid,
    );
  const result = (id: number) =>
    rows(db, "SELECT status, result FROM run_now_request WHERE id = ?", id)[0];

  it("IN, US and an unknown code are refused market_not_enabled and nothing is dispatched; AU is not refused", async () => {
    const ids = { IN: add("IN"), US: add("US"), ZZ: add("ZZ") };
    const good = add("AU");
    await runRunNow(ENV, T0, { fetch: net.f, nowMs: () => T0 });
    for (const [code, id] of Object.entries(ids)) {
      expect(result(id), code).toEqual({
        status: "refused",
        result: "refused: market_not_enabled",
      });
    }
    expect(String(result(good)?.result)).not.toBe("refused: market_not_enabled");
    // the only dispatch there may be is the AU one (ingest-batch1 for the AU request)
    for (const c of net.github) expect(c.body).not.toMatch(/"market":\s*"(IN|US|ZZ)"/);
  });
});
