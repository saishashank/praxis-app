// M18 A4 (OPS-103, OPS-104, OPS-106; D-953, D-958, D-961): the slot definitions the clock dispatches for
// the calendar draft and the Turso usage sample, and the 2b recheck window. No network, no secret.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateSlots,
  decideWithSkips,
  isAnnualDay,
  resetClockCache,
  runClock,
  slotKey,
  type ClockEnv,
  type Facts,
} from "../src/clock";
import { isDispatchable } from "../src/dispatch";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const MIN = 60_000;
/** A Sydney wall-clock instant: `date` + `HH:MM` at the given UTC offset (hours). */
const utc = (date: string, time: string, offset: number): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, mi);
};
const slotById = (id: string) => AU_SLOTS.find((s) => s.id === id)!;

describe("calendar-draft (OPS-103, D-961)", () => {
  const s = slotById("calendar-draft");
  it("is a listed-only, market-free Actions slot on 1 November 09:00 that dispatches calendar-draft.yml", () => {
    expect(s).toMatchObject({
      time: "09:00",
      runner: "actions",
      workflow: "calendar-draft.yml",
      annual: { month: 11, day: 1 },
      tradingDaysOnly: false,
      marketBound: false,
      enabled: true,
      requiresListing: true,
    });
    expect(s.inputsKey).toBeUndefined(); // the workflow's market and year inputs are optional: none sent
    expect(DISPATCHABLE_WORKFLOWS).toContain("calendar-draft.yml");
    expect(isDispatchable("calendar-draft.yml")).toBe(true);
  });
  it("a candidate only on 1 November (09:00 to 12:00), on any weekday, never on another day", () => {
    const cand = (date: string, time: string, offset: number) =>
      candidateSlots(sydneyLocal(utc(date, time, offset)))
        .map((x) => x.id)
        .includes("calendar-draft");
    expect(cand("2027-11-01", "09:00", 11)).toBe(true); // a Monday, AEDT
    expect(cand("2026-11-01", "09:00", 11)).toBe(true); // a Sunday
    expect(cand("2027-11-01", "08:59", 11)).toBe(false);
    expect(cand("2027-11-01", "12:00", 11)).toBe(true);
    expect(cand("2027-11-01", "12:01", 11)).toBe(false);
    expect(cand("2027-11-02", "09:00", 11)).toBe(false);
    expect(cand("2027-10-31", "09:00", 11)).toBe(false);
    expect(cand("2027-12-01", "09:00", 11)).toBe(false);
  });
  it("isAnnualDay compares the local month and day", () => {
    expect(isAnnualDay(sydneyLocal(utc("2027-11-01", "09:00", 11)), { month: 11, day: 1 })).toBe(
      true,
    );
    expect(isAnnualDay(sydneyLocal(utc("2027-01-11", "09:00", 11)), { month: 11, day: 1 })).toBe(
      false,
    );
  });
});

describe("turso-usage (OPS-104, D-958)", () => {
  const s = slotById("turso-usage");
  it("is a listed-only daily Actions slot at 06:40 that dispatches turso-usage.yml", () => {
    expect(s).toMatchObject({
      time: "06:40",
      runner: "actions",
      workflow: "turso-usage.yml",
      tradingDaysOnly: false,
      marketBound: false,
      enabled: true,
      requiresListing: true,
    });
    expect(s.annual).toBeUndefined();
    expect(DISPATCHABLE_WORKFLOWS).toContain("turso-usage.yml");
  });
  it("every day, also a Saturday, 06:40 to 08:40 Sydney", () => {
    const cand = (date: string, time: string) =>
      candidateSlots(sydneyLocal(utc(date, time, 11)))
        .map((x) => x.id)
        .includes("turso-usage");
    expect(cand("2026-11-14", "06:40")).toBe(true); // Saturday
    expect(cand("2026-11-15", "06:40")).toBe(true); // Sunday
    expect(cand("2026-11-16", "06:39")).toBe(false);
    expect(cand("2026-11-16", "08:40")).toBe(true);
    expect(cand("2026-11-16", "08:41")).toBe(false);
  });
});

describe("both slots stay off until listed (go-live pattern)", () => {
  const facts = (list: Facts["slotsEnabled"]): Facts => ({
    dispatchEnabled: true,
    marketMode: "off",
    tradingDay: false,
    slotsEnabled: list,
  });
  const local = sydneyLocal(utc("2027-11-01", "09:00", 11));
  it("no list: not-released; a list without them: not-listed; listed: dispatched with no inputs", () => {
    const only = [slotById("calendar-draft")];
    expect(decideWithSkips(local, facts({ kind: "absent" }), new Map(), 0, only)).toMatchObject({
      actions: [],
      skipped: [{ id: "calendar-draft", reason: "not-released" }],
    });
    expect(
      decideWithSkips(local, facts({ kind: "list", ids: new Set(["x"]) }), new Map(), 0, only)
        .skipped,
    ).toEqual([{ id: "calendar-draft", reason: "not-listed" }]);
    const listed = decideWithSkips(
      local,
      facts({ kind: "list", ids: new Set(["calendar-draft"]) }),
      new Map(),
      0,
      only,
    );
    expect(listed.actions).toHaveLength(1);
    expect(listed.actions[0].inputs).toBeUndefined();
  });
});

describe("runClock: calendar-draft and turso-usage dispatch once on their day", () => {
  let db: ReturnType<typeof makeDb>;
  let net: ReturnType<typeof makeNet>;
  const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
  const put = (k: string, v: string) =>
    db
      .prepare(
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(k, v);
  beforeEach(() => {
    db = makeDb();
    net = makeNet(db);
    resetClockCache();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    put("dispatch_enabled", '"1"');
    put("slots_enabled", JSON.stringify(["calendar-draft", "turso-usage"]));
  });
  afterEach(() => vi.restoreAllMocks());

  it("1 November 09:00: one calendar-draft dispatch, none a minute later; the next day none", async () => {
    await tick(utc("2027-11-01", "09:00", 11));
    await tick(utc("2027-11-01", "09:01", 11));
    await tick(utc("2027-11-02", "09:00", 11));
    expect(net.github.filter((c) => c.url.includes("calendar-draft.yml"))).toHaveLength(1);
    const body = JSON.parse(net.github.find((c) => c.url.includes("calendar-draft.yml"))!.body);
    expect(body.ref).toBe("release");
    expect(body.inputs).toBeUndefined();
    const st = db
      .prepare("SELECT value_json FROM worker_state WHERE key = ?")
      .all(slotKey("calendar-draft", "2027-11-01")) as { value_json: string }[];
    expect(JSON.parse(st[0].value_json)).toMatchObject({ s: "dispatched", n: 1 });
  });

  it("turso-usage: once a day at 06:40, on a weekend too", async () => {
    for (const [date, t] of [
      ["2026-11-14", "06:40"],
      ["2026-11-14", "06:41"],
      ["2026-11-15", "06:40"],
    ] as const) {
      await tick(utc(date, t, 11));
    }
    expect(net.github.filter((c) => c.url.includes("turso-usage.yml"))).toHaveLength(2);
  });

  it("nothing is sent before 06:40 or on an ordinary day for calendar-draft", async () => {
    await tick(utc("2026-11-16", "06:39", 11));
    await tick(utc("2026-11-16", "09:00", 11) + 5 * MIN);
    expect(net.github.filter((c) => c.url.includes("calendar-draft.yml"))).toHaveLength(0);
    expect(net.github.filter((c) => c.url.includes("turso-usage.yml"))).toHaveLength(0);
  });
});
