// V1-B1 (D-662): a dispatch that GitHub accepted (204) but whose workflow never closed the night
// is dispatched again, bounded and idempotent. Pure decision tests plus the real-SQLite clock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ATTEMPTS,
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
const KEY = `arena-2a:AU:${MON}`;
const slot = AU_SLOTS.find((s) => s.id === "arena-close")!;
const st = (s: string, n: number, hm: string): StoredState => {
  const raw = JSON.stringify({ s, n, at: new Date(at(hm)).toISOString() });
  return { raw, state: parseState(raw) };
};
const facts = (closed: string[] | undefined): Facts => ({
  dispatchEnabled: true,
  marketMode: "full",
  tradingDay: true,
  slotsEnabled: { kind: "list", ids: new Set(["arena-close"]) },
  closedKeys: closed === undefined ? undefined : new Set(closed),
});
const states = (s: StoredState) => new Map([[slotKey("arena-close", MON), s]]);
const only = [slot];

describe("decide: re-dispatch of an accepted but unclosed arena close", () => {
  it("dispatched at 17:50, no record at 18:20: dispatched again (attempt 2)", () => {
    const a = decide(
      sydneyLocal(at("18:20")),
      facts([]),
      states(st("dispatched", 1, "17:50")),
      at("18:20"),
      only,
    );
    expect(a).toHaveLength(1);
    expect(a[0].attempt).toBe(2);
    expect(a[0].prev).not.toBeNull();
  });
  it("not before afterMin has passed since the dispatch", () => {
    expect(
      decide(
        sydneyLocal(at("18:10")),
        facts([]),
        states(st("dispatched", 1, "17:50")),
        at("18:10"),
        only,
      ),
    ).toEqual([]);
  });
  it("a closed (or running) night is left alone", () => {
    expect(
      decide(
        sydneyLocal(at("18:40")),
        facts([KEY]),
        states(st("dispatched", 1, "17:50")),
        at("18:40"),
        only,
      ),
    ).toEqual([]);
  });
  it("unknown record state (facts without closedKeys) never re-dispatches", () => {
    expect(
      decide(
        sydneyLocal(at("18:40")),
        facts(undefined),
        states(st("dispatched", 1, "17:50")),
        at("18:40"),
        only,
      ),
    ).toEqual([]);
  });
  it("bounded by MAX_ATTEMPTS and by the window end", () => {
    expect(
      decide(
        sydneyLocal(at("19:30")),
        facts([]),
        states(st("dispatched", MAX_ATTEMPTS, "18:20")),
        at("19:30"),
        only,
      ),
    ).toEqual([]);
    expect(
      decide(
        sydneyLocal(at("20:21")),
        facts([]),
        states(st("dispatched", 1, "17:50")),
        at("20:21"),
        only,
      ),
    ).toEqual([]);
    expect(
      decide(
        sydneyLocal(at("20:20")),
        facts([]),
        states(st("dispatched", 1, "17:50")),
        at("20:20"),
        only,
      ),
    ).toHaveLength(1);
  });
  it("a first dispatch is still limited to the catch-up window (18:10)", () => {
    expect(decide(sydneyLocal(at("18:11")), facts([]), new Map(), at("18:11"), only)).toEqual([]);
    expect(decide(sydneyLocal(at("18:10")), facts([]), new Map(), at("18:10"), only)).toHaveLength(
      1,
    );
  });
  it("other slots are unaffected (no recheck field)", () => {
    const ingest = AU_SLOTS.find((s) => s.id === "ingest-batch1")!;
    const s = new Map([[slotKey("ingest-batch1", MON), st("dispatched", 1, "17:30")]]);
    expect(decide(sydneyLocal(at("18:05")), facts([]), s, at("18:05"), [ingest])).toEqual([]);
  });
  it("a non-trading day never re-dispatches", () => {
    const f = { ...facts([]), tradingDay: false };
    expect(
      decide(sydneyLocal(at("18:40")), f, states(st("dispatched", 1, "17:50")), at("18:40"), only),
    ).toEqual([]);
  });
});

describe("runClock: re-dispatch against a real database", () => {
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
    status: string,
    details = "{}",
    startedAt = new Date(at("17:55")).toISOString(),
  ) =>
    db
      .prepare(
        "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, details_json) VALUES ('arena-close', 'AU', ?, ?, ?, ?, ?)",
      )
      .run(KEY, MON, startedAt, status, details);

  beforeEach(() => {
    db = makeDb();
    net = makeNet(db);
    resetClockCache();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
    put("dispatch_enabled", '"1"');
    put("slots_enabled", JSON.stringify(["arena-close"]));
    put(
      slotKey("arena-close", MON),
      JSON.stringify({ s: "dispatched", n: 1, at: new Date(at("17:50")).toISOString() }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  const arenaCalls = () => net.github.filter((c) => c.url.includes("arena-close.yml"));

  it("no run record 30 minutes later: dispatches again once, state becomes attempt 2", async () => {
    const sum = await tick(at("18:20"));
    expect(sum.dispatched).toContain("arena-close");
    expect(arenaCalls()).toHaveLength(1);
    const state = db
      .prepare("SELECT value_json FROM worker_state WHERE key = ?")
      .all(slotKey("arena-close", MON))[0] as { value_json: string };
    expect(JSON.parse(state.value_json)).toMatchObject({ s: "dispatched", n: 2 });
    // the very next minute: the fresh dispatch time keeps it quiet
    await tick(at("18:21"));
    expect(arenaCalls()).toHaveLength(1);
  });
  it("a success record: no second dispatch", async () => {
    record("success");
    await tick(at("18:20"));
    expect(arenaCalls()).toHaveLength(0);
  });
  it("a fresh running record: no dispatch; a lost runner (running for over 45 min): dispatch", async () => {
    record("running");
    await tick(at("18:20"));
    expect(arenaCalls()).toHaveLength(0);
    db.prepare("DELETE FROM run_record WHERE concurrency_key = ?").run(KEY);
    record("running", "{}", new Date(at("17:20")).toISOString());
    await tick(at("18:21"));
    expect(arenaCalls()).toHaveLength(1);
  });
  it("a skipped record counts as closed, except no_completion_marker", async () => {
    record("skipped", '{"reason":"market_off"}');
    await tick(at("18:20"));
    expect(arenaCalls()).toHaveLength(0);
    db.prepare("DELETE FROM run_record WHERE concurrency_key = ?").run(KEY);
    record("skipped", '{"reason":"no_completion_marker"}');
    await tick(at("18:21"));
    expect(arenaCalls()).toHaveLength(1);
  });
  it("a failed record (the workflow ran and failed): dispatch again", async () => {
    record("failed", '{"code":"SqliteError","cohorts":0}');
    await tick(at("18:20"));
    expect(arenaCalls()).toHaveLength(1);
  });
  it("an invariant freeze (failed with navDays) completed the night: no dispatch (D-675)", async () => {
    record("failed", '{"cohorts":2,"failed":1,"frozen":0,"terminal":0,"fills":3,"navDays":2}');
    await tick(at("18:20"));
    expect(arenaCalls()).toHaveLength(0);
  });
  it("at most MAX_ATTEMPTS dispatches in all", async () => {
    for (const hm of ["18:20", "18:51", "19:22", "19:53", "20:15"]) await tick(at(hm));
    expect(arenaCalls()).toHaveLength(MAX_ATTEMPTS - 1); // attempt 1 was the original dispatch
  });
});
