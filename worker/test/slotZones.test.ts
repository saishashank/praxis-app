// M20 A2 (D-1117, D-1089, MKT-110 a): the clock decides a market-bound slot on the wall clock of its OWN market zone.
// An enabled IN row fires ingest-batch1:IN at 16:30 Kolkata and not at the Sydney minute; a US slot is decided on the
// New York date (a US evening is already the next day in Sydney); AU and the ops slots keep the home clock, so the AU
// table is byte-identical (worker/test/auSlots.test.ts). Real SQLite with migrations 0034 and 0036.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateSlots,
  decideWithSkips,
  localOf,
  resetClockCache,
  runClock,
  slotKey,
} from "../src/clock";
import type { ClockEnv, Facts } from "../src/clock";
import { localFor, sydneyLocal } from "../src/localtime";
import { slotsFor, slotTable } from "../src/schedule";
import { readMarkets } from "../src/markets";
import { AU_ROW, IN_ROW } from "./auRow";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
/** A local wall clock in a fixed UTC offset (minutes east) to a UTC instant. */
const atOffset = (date: string, hm: string, offsetMin: number) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, m) - offsetMin * 60_000;
};
const kolkata = (date: string, hm: string) => atOffset(date, hm, 330);
const sydneyAest = (date: string, hm: string) => atOffset(date, hm, 600);
const newYorkEdt = (date: string, hm: string) => atOffset(date, hm, -240);
const MON = "2026-06-15"; // a Monday in June: AEST, EDT

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
const enable = (code: string, mode: string) =>
  db.prepare("UPDATE market SET enabled = 1, mode = ? WHERE code = ?").run(mode, code);
const session = (code: string, d: string) =>
  db
    .prepare(
      "INSERT INTO trading_calendar (market, d, kind, source) VALUES (?, ?, 'session', 'test')",
    )
    .run(code, d);
const inputsOf = (i: number) => JSON.parse(net.github[i]!.body).inputs as Record<string, string>;

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Slot.tz", () => {
  it("the AU table has no tz anywhere (byte-identical); IN and US market-bound slots carry their zone, ops slots never", () => {
    expect(slotsFor(AU_ROW).filter((s) => s.tz !== undefined)).toEqual([]);
    const inSlots = slotsFor({ ...IN_ROW, enabled: 1 });
    for (const s of inSlots) {
      if (s.marketBound) expect(s.tz, s.id).toBe("Asia/Kolkata");
      else expect(s.tz, s.id).toBeUndefined();
    }
    expect(inSlots.some((s) => s.marketBound)).toBe(true);
    // no IN feed slots: the daily-file sources ride in batch 1 (D-1117)
    const ids = inSlots.map((s) => s.id);
    for (const feed of [
      "asx-poll",
      "universe",
      "asx-fetch",
      "decision-cutoff",
      "late-sweep",
      "marker-check",
    ])
      expect(ids).not.toContain(feed);
  });

  it("localOf: the slot's own zone when it has one, else the home clock; a zoned slot with no instant has no clock", () => {
    const t = newYorkEdt(MON, "17:00");
    const home = sydneyLocal(t);
    const au = slotsFor(AU_ROW).find((s) => s.id === "ingest-batch1")!;
    expect(localOf(au, home, t)).toBe(home);
    const us = { ...au, tz: "America/New_York" };
    expect(localOf(us, home, t)).toMatchObject({ date: MON, minute: 1020 });
    expect(localOf(us, home, undefined)).toBeNull();
    expect(localOf({ ...au, tz: "Asia/Tokyo" }, home, t)).toBeNull();
  });
});

describe("the clock decides on the slot's own zone", () => {
  it("an enabled IN row fires ingest-batch1:IN at 16:30 Kolkata and not at the Sydney minute", async () => {
    enable("IN", "data_only");
    session("IN", MON);
    setState("dispatch_enabled", '"1"');
    const table = slotTable(await readMarkets(ENV, net.f, 0));
    const inBatch = table.slots.find((s) => s.id === "ingest-batch1:IN")!;
    expect(inBatch).toMatchObject({ time: "16:30", market: "IN", tz: "Asia/Kolkata" });
    expect(table.slots.find((s) => s.id === "ingest-batch1")!.tz).toBeUndefined(); // AU: home clock

    // 16:35 in Sydney: IN is at 12:05, its batch is not due
    const sydney = await tick(sydneyAest(MON, "16:35"));
    expect(sydney.dispatched).toEqual([]);
    // 16:35 in Kolkata (= 21:05 in Sydney): due
    const t = kolkata(MON, "16:35");
    const s = await tick(t);
    expect(s.dispatched).toEqual(["ingest-batch1:IN"]);
    expect(inputsOf(0)).toEqual({ market: "IN" });
    // the claim is keyed by the Kolkata date
    expect(
      db
        .prepare("SELECT key FROM worker_state WHERE key = ?")
        .all(slotKey("ingest-batch1:IN", MON)),
    ).toHaveLength(1);
    // the AU batch is untouched: due at 17:30 Sydney
    resetClockCache();
    const au = await tick(sydneyAest(MON, "17:35"));
    expect(au.dispatched).toEqual(["ingest-batch1"]);
    expect(inputsOf(1)).toEqual({ market: "AU" });
  });

  it("a US slot is decided on the New York date: 17:05 EDT Monday is Tuesday in Sydney", async () => {
    enable("US", "full");
    session("US", MON); // New York Monday trades; the Sydney date of that instant (Tuesday) has no US row
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["arena-close:US"]));
    const t = newYorkEdt(MON, "17:25"); // US batch 2a is b1 + 20 = 17:20 ET
    expect(sydneyLocal(t).date).toBe("2026-06-16");
    expect(localFor("America/New_York", t).date).toBe(MON);
    const s = await tick(t);
    expect(s.dispatched).toEqual(["ingest-batch1:US", "arena-close:US"]); // batch 1 is not a trading-day slot
    expect(inputsOf(0)).toEqual({ market: "US" });
    expect(inputsOf(1)).toEqual({ market: "US" });
    expect(
      db.prepare("SELECT key FROM worker_state WHERE key = ?").all(slotKey("arena-close:US", MON)),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT key FROM worker_state WHERE key = ?")
        .all(slotKey("arena-close:US", "2026-06-16")),
    ).toHaveLength(0);
  });

  it("a trading-day slot of IN is refused on its own date's calendar, not on the Sydney date's", async () => {
    enable("IN", "full");
    session("IN", "2026-06-16"); // a row on another date only: Monday (IN) has no row, so it is not a trading day
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["arena-close:IN"]));
    const s = await tick(kolkata(MON, "16:55")); // b2a 16:50 IST
    // batch 1 (every day) runs; arena-close needs a trading day and Monday has no IN row
    expect(s.dispatched).toEqual(["ingest-batch1:IN"]);
    expect(net.github).toHaveLength(1);
  });

  it("decideWithSkips: a zoned slot needs the instant; the same slot on the right instant is due", () => {
    const t = kolkata(MON, "16:35");
    const slots = slotsFor({ ...IN_ROW, enabled: 1, mode: "data_only" }, { tag: true });
    const facts: Facts = {
      dispatchEnabled: true,
      marketMode: "data_only",
      tradingDay: true,
      marketModes: { IN: "data_only" },
      tradingDays: { IN: true },
    };
    const home = sydneyLocal(t);
    expect(candidateSlots(home, slots).filter((s) => s.tz !== undefined)).toEqual([]); // no instant: no zoned slot is due
    expect(
      candidateSlots(home, slots, t)
        .filter((s) => s.tz !== undefined)
        .map((s) => s.id),
    ).toEqual(["ingest-batch1"]);
    const out = decideWithSkips(home, facts, new Map(), t, slots, t).actions;
    expect(out.map((a) => a.slot.id)).toEqual(["ingest-batch1"]);
    expect(out[0]!.key).toBe(slotKey("ingest-batch1", MON));
  });
});
