// M19 C1 (MKT-110 a, AT-68 (a), D-994, D-996, D-1004): the Worker builds its slot table per ENABLED market
// row and refuses everything else. A market that is not enabled has no slot, no dispatch and no run-now;
// a built-off market that is enabled (mode off) gets its slots but nothing market-bound runs; a market
// whose zone the Worker cannot compute is left out, never guessed. Real SQLite with migration 0034.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClockCache, runClock, slotKey, type ClockEnv } from "../src/clock";
import { DbError, MarketNotEnabledError, pipeline } from "../src/db";
import { localFor, zoneSupported } from "../src/localtime";
import { MARKETS_SQL, parseMarketRows, readMarkets } from "../src/markets";
import { runRunNow, type RunNowEnv } from "../src/runNow";
import { slotTable } from "../src/schedule";
import { AU_ROW, IN_ROW, warmMarkets } from "./auRow";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv & RunNowEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  APP_BASE_URL: "https://praxis-app.example.test",
  WORKER_HMAC_SECRET: "7".repeat(64),
};
// Local Sydney time to a UTC instant for a fixed offset (10 = AEST, 11 = AEDT).
const at = (date: string, hm: string, offset = 10) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};
const MON = "2026-06-15"; // AEST Monday, a seeded AU session day

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
let logs: string[];

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
const githubFiles = () => net.github.map((c) => /workflows\/([^/]+)\/dispatches/.exec(c.url)![1]);
const rollups = () =>
  rows(db, "SELECT * FROM run_record WHERE job = 'worker-clock' AND status = 'success'");
/** IN enabled in the AU zone (the Worker can compute it), mode as given: the built-off market switched on. */
const enableIn = (mode: string) =>
  db
    .prepare("UPDATE market SET enabled = 1, tz = 'Australia/Sydney', mode = ? WHERE code = 'IN'")
    .run(mode);

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the market rows the Worker reads (migration 0034)", () => {
  it("one statement returns the enabled rows only: AU under the seed, never IN or US", async () => {
    expect(MARKETS_SQL).toBe(
      "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json FROM market WHERE enabled = 1",
    );
    const read = await readMarkets(ENV, net.f, 0);
    expect(read.map((r) => r.code)).toEqual(["AU"]);
    expect(rows(db, "SELECT code, enabled, mode FROM market ORDER BY code")).toEqual([
      { code: "AU", enabled: 1, mode: "data_only" },
      { code: "IN", enabled: 0, mode: "off" },
      { code: "US", enabled: 0, mode: "off" },
    ]);
  });

  it("the migration's AU and IN rows are the rows the Worker tests build their tables from", async () => {
    const all = parseMarketRows(
      rows(
        db,
        "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, 1 AS enabled, slots_json FROM market",
      ).map((r) => Object.values(r) as never),
    );
    expect(all.find((r) => r.code === "AU")).toEqual(AU_ROW);
    expect(all.find((r) => r.code === "IN")).toEqual({ ...IN_ROW, enabled: 1 });
  });

  it("a row that is not enabled never reaches the slot table", () => {
    const parsed = parseMarketRows([
      ["IN", IN_ROW.tz, "09:15", "15:30", "17:30", "INR", "off", 0, IN_ROW.slots_json],
    ]);
    expect(parsed).toEqual([]);
    expect(slotTable(parsed).slots).toEqual([]);
  });
});

describe("the clock builds its table from the enabled markets (production path)", () => {
  it("AU alone: a nightly job is dispatched, the rollup carries AU, the cold isolate costs one extra request", async () => {
    setState("dispatch_enabled", '"1"');
    const t = at(MON, "22:30");
    const s = await tick(t);
    expect(s.dispatched).toEqual(["maintenance"]);
    expect(s.requests).toBe(4); // cold market read (with the rollup insert), read, claim, record
    expect(rollups()[0]).toMatchObject({ concurrency_key: `worker-clock:AU:${MON}`, market: "AU" });
    resetClockCache();
    warmMarkets();
    const before = net.pipelines;
    await tick(at(MON, "23:00"));
    expect(net.pipelines - before).toBe(3); // a warm isolate: read, claim, record
  });

  it("an idle minute costs no request while the isolate knows the markets", async () => {
    const t = at(MON, "12:00");
    await tick(t); // cold: rollup + market read in ONE request
    expect(net.pipelines).toBe(1);
    for (let i = 1; i <= 8; i++) await tick(t + i * 60_000);
    expect(net.pipelines).toBe(1);
  });

  it("IN under the seed (enabled 0): no IN slot, no dispatch for IN, whatever its time", async () => {
    setState("dispatch_enabled", '"1"');
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'IN'").run();
    const table = slotTable(await readMarkets(ENV, net.f, 0));
    expect(table.slots.some((x) => x.id.includes("IN") || x.market === "IN")).toBe(false);
    // 16:35 is inside IN's batch-1 window (b1 16:30); with IN not enabled nothing runs for it
    const s = await tick(at(MON, "16:35"));
    expect(s.dispatched).toEqual([]);
    expect(githubFiles()).toEqual([]);
  });

  it("IN enabled with mode off (built, switched on): its slots exist, nothing market-bound runs for it", async () => {
    enableIn("off");
    setState("dispatch_enabled", '"1"');
    db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
    const table = slotTable(await readMarkets(ENV, net.f, 0));
    expect(table.skipped).toEqual([]);
    const ids = table.slots.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("ingest-batch1"); // AU keeps its ids
    expect(ids).toContain("ingest-batch1:IN");
    expect(ids.filter((i) => i === "maintenance")).toHaveLength(1); // the ops slots appear once
    const inBatch = table.slots.find((x) => x.id === "ingest-batch1:IN")!;
    expect(inBatch).toMatchObject({ market: "IN", time: "16:30", fixedInputs: { market: "IN" } });
    expect(table.slots.find((x) => x.id === "arena-close:IN")!.recheck?.keyPrefix).toBe(
      "arena-2a:IN:",
    );
    // 16:35: IN's batch 1 is due, AU's is not (17:30)
    const s = await tick(at(MON, "16:35"));
    expect(s.dispatched).toEqual([]);
    expect(githubFiles()).toEqual([]);
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
  });

  it("two enabled markets: each market's batch dispatches with its own market input and its own mode", async () => {
    enableIn("data_only");
    db.prepare(
      "INSERT INTO trading_calendar (market, d, kind, source) VALUES ('IN', ?, 'session', 'test')",
    ).run(MON);
    setState("dispatch_enabled", '"1"');
    const s1 = await tick(at(MON, "16:35"));
    expect(s1.dispatched).toEqual(["ingest-batch1:IN"]);
    expect(JSON.parse(net.github[0].body)).toEqual({ ref: "release", inputs: { market: "IN" } });
    expect(
      rows(db, "SELECT key FROM worker_state WHERE key = ?", slotKey("ingest-batch1:IN", MON)),
    ).toHaveLength(1);
    const s2 = await tick(at(MON, "17:32"));
    expect(s2.dispatched).toEqual(["ingest-batch1"]);
    expect(JSON.parse(net.github[1].body)).toEqual({ ref: "release", inputs: { market: "AU" } });
    // the daily rollup stays the first market's
    expect(rollups().map((r) => r.concurrency_key)).toEqual([`worker-clock:AU:${MON}`]);
  });

  it("a market whose zone the Worker cannot compute is left out and named; AU still runs (D-1004)", async () => {
    db.prepare("UPDATE market SET enabled = 1 WHERE code = 'IN'").run(); // tz Asia/Kolkata
    setState("dispatch_enabled", '"1"');
    const table = slotTable(await readMarkets(ENV, net.f, 0));
    expect(table.skipped).toEqual(["IN"]);
    expect(table.slots.some((x) => x.id.includes("IN"))).toBe(false);
    const s = await tick(at(MON, "22:30"));
    expect(s.dispatched).toEqual(["maintenance"]);
    expect(logs.join("\n")).toContain("clock: skipped market IN unusable");
    expect(zoneSupported(IN_ROW.tz)).toBe(false);
    expect(() => localFor(IN_ROW.tz, 0)).toThrow("unsupported zone");
    expect(localFor(AU_ROW.tz, at(MON, "10:00")).minute).toBe(600);
  });

  it("a market enabled or re-timed since the table was built: the tick remembers it and dispatches nothing", async () => {
    setState("dispatch_enabled", '"1"');
    await tick(at(MON, "22:25")); // learns AU only (cached for 10 minutes)
    enableIn("off");
    const before = net.github.length;
    const s = await tick(at(MON, "22:30"));
    expect(s.dispatched).toEqual([]);
    expect(net.github).toHaveLength(before);
    expect(logs.join("\n")).toContain("clock: markets changed");
    const s2 = await tick(at(MON, "22:31")); // the next minute decides with the right table
    expect(s2.dispatched).toEqual(["maintenance"]);
  });

  it("no enabled market at all: the clock dispatches nothing (fail safe)", async () => {
    setState("dispatch_enabled", '"1"');
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    db.prepare("UPDATE market SET enabled = 0 WHERE code = 'AU'").run();
    const s = await tick(at(MON, "22:30"));
    expect(s.dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
  });
});

describe("run now refuses a market that is not enabled (D-996)", () => {
  const T0 = Date.UTC(2026, 9, 18, 16, 0); // Mon 19 Oct 2026 03:00 Sydney
  const add = (jobId: string, market: string) =>
    Number(
      (
        db
          .prepare(
            "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, audit_ref, status, updated_at) " +
              "VALUES (?, ?, '{}', ?, ?, 'audit:1', 'pending', ?)",
          )
          .run(
            jobId,
            market,
            "a".repeat(64),
            new Date(T0 - 60_000).toISOString(),
            new Date(T0 - 60_000).toISOString(),
          ) as unknown as {
          lastInsertRowid: number | bigint;
        }
      ).lastInsertRowid,
    );
  const result = (id: number) =>
    rows(db, "SELECT status, result FROM run_now_request WHERE id = ?", id)[0] as {
      status: string;
      result: string;
    };
  const run = () => runRunNow(ENV, T0, { fetch: net.f, nowMs: () => T0 });

  it("a request for IN under the seed is refused market_not_enabled, before any other gate", async () => {
    setState("dispatch_enabled", '"1"');
    const id = add("ingest-batch1", "IN");
    const s = await run();
    expect(s.refused).toEqual(["ingest-batch1"]);
    expect(result(id)).toEqual({ status: "refused", result: "refused: market_not_enabled" });
    expect(net.github).toHaveLength(0);
  });

  it("an unknown market code is refused the same way; AU is not", async () => {
    setState("dispatch_enabled", '"1"');
    const bad = add("backup", "ZZ");
    const good = add("backup", "AU");
    await run();
    expect(result(bad).result).toBe("refused: market_not_enabled");
    expect(result(good).result).toMatch(/^started/);
    expect(githubFiles()).toEqual(["backup.yml"]);
  });

  it("IN enabled with mode off: market_not_enabled is gone, the market-bound gate (market is off) refuses it", async () => {
    enableIn("off");
    setState("dispatch_enabled", '"1"');
    const id = add("ingest-batch1", "IN");
    await run();
    expect(result(id).result).toBe("refused: market is off");
  });
});

describe("the write guard's refusal is a fixed word in the Worker (D-995)", () => {
  it("a statement error carrying MarketNotEnabled becomes MarketNotEnabledError, never the message", async () => {
    const f = (async () =>
      Response.json({
        results: [
          { type: "error", error: { message: "SQLite error: MarketNotEnabled price_bar" } },
          { type: "ok" },
        ],
      })) as unknown as typeof fetch;
    await expect(pipeline(ENV, [{ sql: "INSERT INTO price_bar VALUES (1)" }], f)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof MarketNotEnabledError &&
        e instanceof DbError &&
        e.name === "MarketNotEnabled" &&
        !String(e.message).includes("price_bar"),
    );
  });
});
