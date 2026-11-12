// M20 A2 (D-1101, D-1117; AT-71): the rollback kill slot. `arena-kill:<CODE>` exists only while the market row has
// `rollback_at`, runs at open + 2 minutes in the market's own zone on a trading day, and is dispatched although the
// market is already off (it is not market-bound). The close itself is stream S1's; this is the schedule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClockCache, runClock, slotKey, type ClockEnv } from "../src/clock";
import { parseMarketRows } from "../src/markets";
import { KILL_AFTER_OPEN_MIN, slotsFor, slotTable } from "../src/schedule";
import { AU_ROW, IN_ROW } from "./auRow";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const atOffset = (date: string, hm: string, offsetMin: number) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - offsetMin * 60_000;
};
const kolkata = (date: string, hm: string) => atOffset(date, hm, 330);
const MON = "2026-06-15";
const ROLLBACK = "2026-06-12T08:00:00.000Z";

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
/** IN switched full -> off and awaiting its kill: enabled 1, mode off, rollback_at set. */
const rollbackIn = (withRollback: boolean) => {
  db.prepare("UPDATE market SET enabled = 1, mode = 'off', rollback_at = ? WHERE code = 'IN'").run(
    withRollback ? ROLLBACK : null,
  );
  db.prepare(
    "INSERT INTO trading_calendar (market, d, kind, source) VALUES ('IN', ?, 'session', 'test')",
  ).run(MON);
  setState("dispatch_enabled", '"1"');
};

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the kill slot in the table", () => {
  it("exists only with rollback_at: at open + 2 in the market's zone, not market-bound, tagged with its market", () => {
    expect(KILL_AFTER_OPEN_MIN).toBe(2);
    const without = slotsFor({ ...IN_ROW, enabled: 1 });
    expect(without.some((s) => s.id.startsWith("arena-kill"))).toBe(false);
    const withIt = slotsFor({ ...IN_ROW, enabled: 1, rollback_at: ROLLBACK });
    const kill = withIt.find((s) => s.id === "arena-kill:IN")!;
    expect(kill).toMatchObject({
      time: "09:17", // open 09:15 + 2
      minute: 9 * 60 + 17,
      runner: "actions",
      workflow: "arena-close.yml",
      fixedInputs: { market: "IN", kill: "1" },
      market: "IN",
      tz: "Asia/Kolkata",
      tradingDaysOnly: true,
      marketBound: false,
      enabled: true,
    });
    expect(kill.requiresListing).toBeUndefined(); // a rollback must not wait for the Owner to list a slot
    expect(withIt).toHaveLength(without.length + 1);
  });

  it("an empty rollback_at is no rollback; AU never has a tz on it", () => {
    expect(
      slotsFor({ ...IN_ROW, enabled: 1, rollback_at: "" }).some((s) =>
        s.id.startsWith("arena-kill"),
      ),
    ).toBe(false);
    const au = slotsFor({ ...AU_ROW, rollback_at: ROLLBACK }).find(
      (s) => s.id === "arena-kill:AU",
    )!;
    expect(au.time).toBe("10:02");
    expect(au.tz).toBeUndefined();
  });

  it("the market rows carry rollback_at only while it is set; an ordinary row is unchanged", async () => {
    const cols = (r: object[]) => r.map((x) => ({ ...x }));
    const parsed = parseMarketRows(
      cols(
        rows(
          db,
          "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json, rollback_at FROM market WHERE code = 'AU'",
        ),
      ).map((o) => Object.values(o) as never),
    );
    expect(parsed[0]).toEqual(AU_ROW);
    expect("rollback_at" in parsed[0]!).toBe(false);
    rollbackIn(true);
    const r = rows(
      db,
      "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json, rollback_at FROM market WHERE code = 'IN'",
    );
    expect(parseMarketRows(r.map((o) => Object.values(o) as never))[0]!.rollback_at).toBe(ROLLBACK);
  });
});

describe("the clock dispatches the kill", () => {
  it("at 09:17 Kolkata on a trading day, with the market already off: arena-close with market and kill inputs", async () => {
    rollbackIn(true);
    const table = slotTable(
      parseMarketRows(
        rows(
          db,
          "SELECT code, tz, open_time, close_time, cutoff_time, currency, mode, enabled, slots_json, rollback_at FROM market WHERE enabled = 1",
        ).map((o) => Object.values(o) as never),
      ),
    );
    expect(table.slots.some((s) => s.id === "arena-kill:IN")).toBe(true);
    expect(await tick(kolkata(MON, "09:16"))).toMatchObject({ dispatched: [] }); // before open + 2
    const s = await tick(kolkata(MON, "09:19"));
    expect(s.dispatched).toEqual(["arena-kill:IN"]);
    expect(JSON.parse(net.github[0]!.body)).toEqual({
      ref: "release",
      inputs: { market: "IN", kill: "1" },
    });
    expect(
      rows(db, "SELECT key FROM worker_state WHERE key = ?", slotKey("arena-kill:IN", MON)),
    ).toHaveLength(1);
  });

  it("nothing without rollback_at (mode off: no market-bound slot runs), and not after the catch-up window", async () => {
    rollbackIn(false);
    expect((await tick(kolkata(MON, "09:19"))).dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
    resetClockCache();
    db.prepare("UPDATE market SET rollback_at = ? WHERE code = 'IN'").run(ROLLBACK);
    expect((await tick(kolkata(MON, "09:40"))).dispatched).toEqual([]); // 09:17 + 20 min catch-up has passed
    expect(net.github).toHaveLength(0);
  });

  it("not on a day the market does not trade", async () => {
    rollbackIn(true);
    // Saturday 2026-06-13: no session row and a weekend
    expect((await tick(kolkata("2026-06-13", "09:19"))).dispatched).toEqual([]);
  });
});
