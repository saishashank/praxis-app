// OPS-106 / D-953 / D-666 (M18 A4, AT-84): a 2b that skipped with `no_2a_success` because 2a closed
// late is dispatched again EXACTLY ONCE, only after 2a has a success/degraded record, only between
// 18:25 and 18:40 Sydney time. Scheduling only: nothing here changes what 2b decides. Pure decision
// cases plus the real-SQLite clock (as recheck.test.ts). AEST Monday, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECHECK_CLOSED_SQL,
  decide,
  parseState,
  resetClockCache,
  runClock,
  slotKey,
  type ClockEnv,
  type Facts,
  type StoredState,
} from "../src/clock";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const MON = "2026-06-15"; // AEST Monday
const at = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return Date.UTC(2026, 5, 15, h - 10, m);
};
const iso = (hm: string) => new Date(at(hm)).toISOString();
const KEY_2A = `arena-2a:AU:${MON}`;
const KEY_2B = `arena-2b:AU:${MON}`;
const slot = AU_SLOTS.find((s) => s.id === "arena-signals")!;
const only = [slot];
const stored = (s: string, n: number, hm: string): StoredState => {
  const raw = JSON.stringify({ s, n, at: iso(hm) });
  return { raw, state: parseState(raw) };
};
const states = (s: StoredState) => new Map([[slotKey("arena-signals", MON), s]]);
const facts = (over: Partial<Facts> = {}): Facts => ({
  dispatchEnabled: true,
  marketMode: "full",
  tradingDay: true,
  slotsEnabled: { kind: "list", ids: new Set(["arena-signals"]) },
  closedKeys: new Set(),
  settledKeys: new Set([KEY_2A]),
  ...over,
});

describe("the arena-signals slot (D-953)", () => {
  it("rechecks the 2b night from 18:25 to 18:40 and needs a settled 2a", () => {
    expect(slot.recheck).toEqual({
      keyPrefix: "arena-2b:AU:",
      afterMin: 15,
      untilMin: 30,
      once: true,
      needsKeyPrefix: "arena-2a:AU:",
    });
  });
  it("RECHECK_CLOSED_SQL does not count a no_2a_success skip as closed", () => {
    expect(RECHECK_CLOSED_SQL).toContain("no_2a_success");
  });
});

describe("decide: the 2b re-dispatch", () => {
  const go = (hm: string, f: Facts, st: StoredState) =>
    decide(sydneyLocal(at(hm)), f, states(st), at(hm), only);
  const first = stored("dispatched", 1, "18:10");

  it("18:12: too early, whatever the facts say", () => {
    expect(go("18:12", facts(), first)).toEqual([]);
  });
  it("18:24 none; 18:25 with a settled 2a and no closed 2b: attempt 2", () => {
    expect(go("18:24", facts(), first)).toEqual([]);
    const a = go("18:25", facts(), first);
    expect(a).toHaveLength(1);
    expect(a[0].attempt).toBe(2);
    expect(a[0].prev).not.toBeNull();
  });
  it("2a not settled (running or absent): never", () => {
    expect(go("18:31", facts({ settledKeys: new Set() }), first)).toEqual([]);
  });
  it("unknown 2a state (no settledKeys) or unknown 2b state (no closedKeys): never (fail safe)", () => {
    expect(go("18:31", facts({ settledKeys: undefined }), first)).toEqual([]);
    expect(go("18:31", facts({ closedKeys: undefined }), first)).toEqual([]);
  });
  it("a closed or running 2b is left alone", () => {
    expect(go("18:31", facts({ closedKeys: new Set([KEY_2B]) }), first)).toEqual([]);
  });
  it("18:40 is the last minute; 18:41 is outside the window", () => {
    expect(go("18:40", facts(), first)).toHaveLength(1);
    expect(go("18:41", facts(), first)).toEqual([]);
  });
  it("once: a dispatch made inside the recheck window is not re-dispatched again", () => {
    expect(go("18:40", facts(), stored("dispatched", 2, "18:25"))).toEqual([]);
    expect(go("18:40", facts(), stored("dispatched", 2, "18:31"))).toEqual([]);
  });
  it("once: a first attempt that failed and was retried before 18:25 can still be rechecked", () => {
    expect(go("18:40", facts(), stored("dispatched", 2, "18:12"))).toHaveLength(1);
  });
  it("a non-trading day never re-dispatches", () => {
    expect(go("18:31", facts({ tradingDay: false }), first)).toEqual([]);
  });
});

describe("runClock: 2b re-dispatch against a real database", () => {
  let db: ReturnType<typeof makeDb>;
  let net: ReturnType<typeof makeNet>;
  const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
  const put = (k: string, v: string) =>
    db
      .prepare(
        "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(k, v);
  const record = (
    job: string,
    key: string,
    status: string,
    details = "{}",
    startedAt = iso("17:55"),
  ) =>
    db
      .prepare(
        "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, details_json) VALUES (?, 'AU', ?, ?, ?, ?, ?)",
      )
      .run(job, key, MON, startedAt, status, details);
  const skip2b = (hm = "18:30") =>
    record("arena-signals", KEY_2B, "skipped", '{"reason":"no_2a_success"}', iso(hm));
  const calls = () => net.github.filter((c) => c.url.includes("arena-signals.yml"));
  const stateOf = () =>
    JSON.parse(
      (
        db
          .prepare("SELECT value_json FROM worker_state WHERE key = ?")
          .all(slotKey("arena-signals", MON))[0] as { value_json: string }
      ).value_json,
    ) as { s: string; n: number };

  beforeEach(() => {
    db = makeDb();
    net = makeNet(db);
    resetClockCache();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
    put("dispatch_enabled", '"1"');
    put("slots_enabled", JSON.stringify(["arena-signals"]));
    put(slotKey("arena-signals", MON), JSON.stringify({ s: "dispatched", n: 1, at: iso("18:10") }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("18:12 with 2a still running: no dispatch", async () => {
    record("arena-close", KEY_2A, "running");
    await tick(at("18:12"));
    expect(calls()).toHaveLength(0);
  });

  it("2b skipped (no_2a_success) at 18:30 and 2a still running at 18:31: no dispatch", async () => {
    record("arena-close", KEY_2A, "running");
    skip2b();
    await tick(at("18:31"));
    expect(calls()).toHaveLength(0);
  });

  it("2a succeeds at 18:31: exactly one re-dispatch, and none on the ticks that follow (to 18:40)", async () => {
    skip2b();
    record("arena-close", KEY_2A, "success");
    await tick(at("18:31"));
    expect(calls()).toHaveLength(1);
    expect(stateOf()).toMatchObject({ s: "dispatched", n: 2 });
    for (const hm of ["18:32", "18:35", "18:39", "18:40", "18:41", "19:10"]) await tick(at(hm));
    expect(calls()).toHaveLength(1);
  });

  it("a degraded 2a counts as settled too", async () => {
    skip2b();
    record("arena-close", KEY_2A, "degraded");
    await tick(at("18:31"));
    expect(calls()).toHaveLength(1);
  });

  it("2a that only succeeds at 18:41: no dispatch (the night is recorded late_2a by 2b itself)", async () => {
    skip2b();
    await tick(at("18:40"));
    record("arena-close", KEY_2A, "success");
    await tick(at("18:41"));
    await tick(at("18:50"));
    expect(calls()).toHaveLength(0);
  });

  it("two ticks racing for the same minute dispatch once (the claim is the lock)", async () => {
    skip2b();
    record("arena-close", KEY_2A, "success");
    net.interleave = true;
    await Promise.all([tick(at("18:31")), tick(at("18:31"))]);
    expect(calls()).toHaveLength(1);
  });

  it("other 2b outcomes are closed and never re-dispatched", async () => {
    record("arena-close", KEY_2A, "success");
    record("arena-signals", KEY_2B, "skipped", '{"reason":"market_off"}', iso("18:12"));
    await tick(at("18:31"));
    expect(calls()).toHaveLength(0);
    db.prepare("DELETE FROM run_record WHERE concurrency_key = ?").run(KEY_2B);
    record("arena-signals", KEY_2B, "success", "{}", iso("18:12"));
    await tick(at("18:32"));
    expect(calls()).toHaveLength(0);
  });

  it("a fresh running 2b is left alone; no 2b record at all but a settled 2a: one dispatch", async () => {
    record("arena-close", KEY_2A, "success");
    record("arena-signals", KEY_2B, "running", "{}", iso("18:12"));
    await tick(at("18:26"));
    expect(calls()).toHaveLength(0);
    db.prepare("DELETE FROM run_record WHERE concurrency_key = ?").run(KEY_2B);
    await tick(at("18:27"));
    expect(calls()).toHaveLength(1);
  });
});
