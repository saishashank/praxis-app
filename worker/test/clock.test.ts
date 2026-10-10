import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import backupYml from "../../.github/workflows/backup.yml?raw";
import ingestYml from "../../.github/workflows/ingest-batch1.yml?raw";
import maintenanceYml from "../../.github/workflows/maintenance.yml?raw";
import {
  CLAIM_STALE_MS,
  MAX_ATTEMPTS,
  candidateSlots,
  decide,
  parseEnabled,
  parseState,
  resetClockCache,
  runClock,
  slotKey,
  type ClockEnv,
  type Facts,
  type StoredState,
} from "../src/clock";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS, type Slot } from "../src/schedule";
import worker from "../src/index";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};

// Local Sydney time to a UTC instant for a fixed offset (10 = AEST, 11 = AEDT).
const at = (date: string, hm: string, offset = 10) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};
const MON = "2026-06-15"; // AEST Monday
const SAT = "2026-06-13";

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;
let logs: string[];

const deps = (now?: () => number) => ({ fetch: net.f, nowMs: now ?? (() => Date.now()) });
const tick = (t: number, e: ClockEnv = ENV, slots: readonly Slot[] = AU_SLOTS) =>
  runClock(
    e,
    t,
    deps(() => t),
    slots,
  );
const enable = (v = '"1"') =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(v);
const stateRow = (key: string) =>
  rows(db, "SELECT value_json FROM worker_state WHERE key = ?", key)[0]?.value_json as
    string | undefined;
const rollups = () =>
  rows(db, "SELECT * FROM run_record WHERE job = 'worker-clock' AND status = 'success'");
const failures = () =>
  rows(db, "SELECT * FROM run_record WHERE job = 'worker-clock' AND status = 'failed'");

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

describe("slot table (docs/M2_design.md section 3)", () => {
  it("has unique ids, valid times and the design slots", () => {
    const ids = AU_SLOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const by = Object.fromEntries(AU_SLOTS.map((s) => [s.id, s]));
    expect(by["asx-poll"]).toMatchObject({ time: "07:00", until: "19:30", everyMin: 4 });
    expect(by["pre-open"].time).toBe("09:54");
    expect(by["ingest-batch1"]).toMatchObject({ time: "17:30", workflow: "ingest-batch1.yml" });
    expect(by["decision-cutoff"].time).toBe("18:10");
    expect(by["late-sweep"].time).toBe("19:35");
    expect(by["marker-check"].time).toBe("19:50");
    for (const s of AU_SLOTS)
      expect(s.minute).toBe(Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3)));
  });

  it("only workflows that exist today are enabled and allow-listed; later slots are off", () => {
    expect([...DISPATCHABLE_WORKFLOWS].sort()).toEqual([
      "backup.yml",
      "ingest-batch1.yml",
      "maintenance.yml",
    ]);
    for (const s of AU_SLOTS.filter((x) => x.enabled)) {
      expect(s.runner).toBe("actions");
      expect(DISPATCHABLE_WORKFLOWS).toContain(s.workflow);
    }
    expect(AU_SLOTS.find((s) => s.id === "ingest-batch1")).toMatchObject({
      enabled: true,
      runner: "actions",
      workflow: "ingest-batch1.yml",
    });
    for (const id of ["asx-poll", "pre-open", "decision-cutoff", "late-sweep", "marker-check"]) {
      expect(AU_SLOTS.find((s) => s.id === id)?.enabled).toBe(false);
    }
    // The allow-listed files exist and are dispatch-only.
    for (const y of [backupYml, ingestYml, maintenanceYml]) {
      expect(y).toMatch(/^on: workflow_dispatch$/m);
      expect(y).not.toMatch(/^\s*schedule:/m);
    }
  });

  it("nightly slots run every day, ingest slots only on trading days", () => {
    for (const s of AU_SLOTS) {
      if (s.id === "backup" || s.id === "maintenance") expect(s.tradingDaysOnly).toBe(false);
      else expect(s.tradingDaysOnly).toBe(true);
    }
  });
});

describe("candidateSlots (pure)", () => {
  const L = (date: string, hm: string) => sydneyLocal(at(date, hm));
  it("nothing before the first slot window", () => {
    expect(candidateSlots(L(MON, "22:29"))).toEqual([]);
    expect(candidateSlots(L(MON, "03:00"))).toEqual([]);
  });
  it("maintenance from 22:30, backup from 23:00 (priority order), catch-up window closes", () => {
    expect(candidateSlots(L(MON, "22:30")).map((s) => s.id)).toEqual(["maintenance"]);
    expect(candidateSlots(L(MON, "23:00")).map((s) => s.id)).toEqual(["maintenance", "backup"]);
    expect(candidateSlots(L(MON, "23:30")).map((s) => s.id)).toEqual(["maintenance", "backup"]);
    expect(candidateSlots(L(MON, "23:31")).map((s) => s.id)).toEqual(["backup"]);
    expect(candidateSlots(L(MON, "23:59")).map((s) => s.id)).toEqual(["backup"]);
  });
  it("nightly slots also run on weekends", () => {
    expect(candidateSlots(L(SAT, "23:00")).map((s) => s.id)).toEqual(["maintenance", "backup"]);
  });
  it("a disabled slot is never a candidate; recurring and Worker-run slots never are", () => {
    const all = AU_SLOTS.map((s) => ({ ...s, enabled: true }));
    const ids = candidateSlots(L(MON, "17:30"), all).map((s) => s.id);
    expect(ids).toEqual(["ingest-batch1"]); // not asx-poll, pre-open, late-sweep (runner worker)
    const off = AU_SLOTS.map((s) => ({ ...s, enabled: false }));
    expect(candidateSlots(L(MON, "17:30"), off)).toEqual([]);
    expect(candidateSlots(L(MON, "17:30")).map((s) => s.id)).toEqual(["ingest-batch1"]);
  });
  it("trading-day-only slots skip weekends", () => {
    const all = AU_SLOTS.map((s) => ({ ...s, enabled: true }));
    expect(candidateSlots(L(SAT, "17:30"), all)).toEqual([]);
    expect(candidateSlots(L("2026-06-14", "17:35"), all)).toEqual([]); // Sunday
    expect(candidateSlots(L(MON, "17:35"), all).map((s) => s.id)).toEqual(["ingest-batch1"]);
  });
  it("catch-up: a slot missed at 17:30 is still open until 18:10, then closed", () => {
    const all = AU_SLOTS.map((s) => ({ ...s, enabled: true }));
    expect(candidateSlots(L(MON, "18:10"), all).map((s) => s.id)).toContain("ingest-batch1");
    expect(candidateSlots(L(MON, "18:11"), all).map((s) => s.id)).not.toContain("ingest-batch1");
  });
  it("DST gap: a slot inside the spring-forward gap is caught up at 03:00 local", () => {
    const gap: Slot = {
      ...AU_SLOTS[0],
      id: "gap",
      runner: "actions",
      workflow: "backup.yml",
      everyMin: undefined,
      tradingDaysOnly: false,
      enabled: true,
      time: "02:30",
      minute: 150,
      catchUpMin: 60,
    };
    const d = "2026-10-04"; // spring forward day, 02:00 AEST -> 03:00 AEDT
    expect(candidateSlots(sydneyLocal(Date.UTC(2026, 9, 3, 15, 59)), [gap])).toEqual([]); // 01:59
    expect(
      candidateSlots(sydneyLocal(Date.UTC(2026, 9, 3, 16, 0)), [gap]).map((s) => s.id),
    ).toEqual(["gap"]); // 03:00
    expect(d).toBe(sydneyLocal(Date.UTC(2026, 9, 3, 16, 0)).date);
  });
  it("DST overlap: the repeated hour yields a candidate twice, one key", () => {
    const slotAt: Slot = {
      ...AU_SLOTS[0],
      id: "ov",
      runner: "actions",
      workflow: "backup.yml",
      everyMin: undefined,
      tradingDaysOnly: false,
      enabled: true,
      time: "02:30",
      minute: 150,
      catchUpMin: 0,
    };
    const first = sydneyLocal(Date.UTC(2026, 3, 4, 15, 30)); // 02:30 AEDT (first)
    const second = sydneyLocal(Date.UTC(2026, 3, 4, 16, 30)); // 02:30 AEST (second)
    expect(first.minute).toBe(150);
    expect(second.minute).toBe(150);
    expect(slotKey("ov", first.date)).toBe(slotKey("ov", second.date));
    expect(candidateSlots(first, [slotAt])).toHaveLength(1);
  });
});

describe("decide (pure)", () => {
  const L = sydneyLocal(at(MON, "23:00"));
  const on: Facts = { dispatchEnabled: true, marketMode: "data_only", tradingDay: true };
  const none = new Map<string, StoredState>();
  const st = (s: string, n: number, atMs: number): StoredState => {
    const raw = JSON.stringify({ s, n, at: new Date(atMs).toISOString() });
    return { raw, state: parseState(raw) };
  };
  const NOW = at(MON, "23:00");

  it("kill switch default: nothing", () => {
    expect(decide(L, { ...on, dispatchEnabled: false }, none, NOW)).toEqual([]);
    expect(parseEnabled(undefined)).toBe(false);
    for (const v of ['"0"', "0", "false", "", "null", "garbage", '"yes"']) {
      expect(parseEnabled(v)).toBe(false);
    }
    for (const v of ['"1"', "1", "true"]) expect(parseEnabled(v)).toBe(true);
  });
  it("first sight: both nightly slots, attempt 1, no prev", () => {
    const a = decide(L, on, none, NOW);
    expect(a.map((x) => [x.slot.id, x.attempt, x.prev])).toEqual([
      ["maintenance", 1, null],
      ["backup", 1, null],
    ]);
  });
  it("market off does not stop nightly (not market-bound) but stops market-bound slots", () => {
    const off: Facts = { ...on, marketMode: "off" };
    expect(decide(L, off, none, NOW)).toHaveLength(2);
    expect(decide(L, { ...on, marketMode: null }, none, NOW)).toHaveLength(2);
    const all = AU_SLOTS.map((s) => ({ ...s, enabled: true }));
    const l2 = sydneyLocal(at(MON, "17:35"));
    expect(decide(l2, off, none, NOW, all)).toEqual([]);
    expect(decide(l2, { ...on, marketMode: null }, none, NOW, all)).toEqual([]);
    expect(decide(l2, on, none, NOW, all)).toHaveLength(1);
    expect(decide(l2, { ...on, marketMode: "full" }, none, NOW, all)).toHaveLength(1);
  });
  it("holiday: trading-day-only slot skipped, nightly slots still run", () => {
    const all = AU_SLOTS.map((s) => ({ ...s, enabled: true }));
    const l2 = sydneyLocal(at(MON, "17:35"));
    expect(decide(l2, { ...on, tradingDay: false }, none, NOW, all)).toEqual([]);
    expect(decide(L, { ...on, tradingDay: false }, none, NOW)).toHaveLength(2);
  });
  it("dispatched or in-flight slots are left alone; failed ones retry up to the cap", () => {
    const k1 = slotKey("maintenance", L.date);
    const k2 = slotKey("backup", L.date);
    const m = new Map<string, StoredState>([
      [k1, st("dispatched", 1, NOW - 60_000)],
      [k2, st("claimed", 1, NOW - 30_000)],
    ]);
    expect(decide(L, on, m, NOW)).toEqual([]);
    m.set(k2, st("failed", 1, NOW - 60_000));
    const a = decide(L, on, m, NOW);
    expect(a.map((x) => [x.slot.id, x.attempt])).toEqual([["backup", 2]]);
    expect(a[0].prev).toBe(m.get(k2)?.raw);
    m.set(k2, st("failed", MAX_ATTEMPTS, NOW - 60_000));
    expect(decide(L, on, m, NOW)).toEqual([]);
  });
  it("a stale claim counts as a crashed attempt; a fresh claim does not", () => {
    const k = slotKey("backup", L.date);
    const done = st("dispatched", 1, NOW);
    const m = new Map<string, StoredState>([[slotKey("maintenance", L.date), done]]);
    m.set(k, st("claimed", 1, NOW - CLAIM_STALE_MS + 1));
    expect(decide(L, on, m, NOW)).toEqual([]);
    m.set(k, st("claimed", 1, NOW - CLAIM_STALE_MS));
    expect(decide(L, on, m, NOW).map((x) => x.attempt)).toEqual([2]);
    m.set(k, st("claimed", MAX_ATTEMPTS, NOW - CLAIM_STALE_MS));
    expect(decide(L, on, m, NOW)).toEqual([]);
  });
  it("an unreadable state is never dispatched over", () => {
    const m = new Map<string, StoredState>([
      [slotKey("maintenance", L.date), { raw: "{bad", state: parseState("{bad") }],
      [slotKey("backup", L.date), { raw: "[]", state: parseState("[]") }],
    ]);
    expect(decide(L, on, m, NOW)).toEqual([]);
  });
  it("the decision is cheap: 1000 decisions well under 1 ms each (proxy for the 10 ms budget)", () => {
    const m = new Map<string, StoredState>();
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      decide(sydneyLocal(at(MON, "23:00") + i * 60_000), on, m, NOW);
    }
    const per = (performance.now() - t0) / 1000;
    expect(per).toBeLessThan(1);
  });
});

describe("runClock with a real SQLite database", () => {
  it("kill switch is off by default: nothing is claimed or dispatched, window ticks read once", async () => {
    const t = at(MON, "22:30");
    const s = await tick(t);
    expect(s.dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
    expect(rows(db, "SELECT key FROM worker_state")).toEqual([]);
    expect(net.pipelines).toBe(1); // rollup + state read share one request
    await tick(t + 60_000);
    expect(net.pipelines).toBe(2); // window open: one read per tick, no writes
    expect(rows(db, "SELECT key FROM worker_state")).toEqual([]);
  });

  it("dispatches maintenance at 22:30 once with the exact request, records state and rollup", async () => {
    enable();
    const t = at(MON, "22:30");
    const s = await tick(t);
    expect(s.dispatched).toEqual(["maintenance"]);
    expect(net.github).toHaveLength(1);
    const c = net.github[0];
    expect(c.url).toBe(
      "https://api.github.com/repos/saishashank/praxis-app/actions/workflows/maintenance.yml/dispatches",
    );
    expect(c.method).toBe("POST");
    expect(JSON.parse(c.body)).toEqual({ ref: "release" });
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(c.headers["User-Agent"]).toBeTruthy();
    expect(c.headers.Accept).toBe("application/vnd.github+json");
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!)).toMatchObject({
      s: "dispatched",
      n: 1,
    });
    const r = rollups();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      concurrency_key: `worker-clock:AU:${MON}`,
      market: "AU",
      scheduled_for: MON,
      items_processed: 1,
    });
    // request budget: read, claim, record
    expect(net.pipelines).toBe(3);
  });

  it("never twice for the same slot and date, even from a fresh isolate or a later minute", async () => {
    enable();
    await tick(at(MON, "22:30"));
    resetClockCache(); // a new isolate
    await tick(at(MON, "22:30"));
    await tick(at(MON, "22:31"));
    await tick(at(MON, "23:29"));
    expect(net.github.filter((c) => c.url.includes("maintenance.yml"))).toHaveLength(1);
    expect(rollups()).toHaveLength(1);
  });

  it("two isolates racing for the same slot: exactly one dispatch (conditional insert)", async () => {
    enable();
    net.interleave = true;
    const t = at(MON, "22:30");
    const [a, b, c] = await Promise.all([tick(t), tick(t), tick(t)]);
    expect(a.dispatched.length + b.dispatched.length + c.dispatched.length).toBe(1);
    expect(net.github).toHaveLength(1);
    expect(rollups()).toHaveLength(1);
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!).s).toBe("dispatched");
  });

  it("racing retries of a failed slot also dispatch once (compare-and-set on the old value)", async () => {
    enable();
    net.githubPlan = [500];
    const t = at(MON, "22:30");
    await tick(t);
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!)).toMatchObject({ s: "failed", n: 1 });
    net.github.length = 0;
    net.interleave = true;
    resetClockCache();
    await Promise.all([tick(t + 60_000), tick(t + 60_000)]);
    expect(net.github).toHaveLength(1);
  });

  it("catch-up after an outage dispatches once inside the window and not after it", async () => {
    enable();
    await tick(at(MON, "23:05")); // Worker was down 22:30..23:04
    expect(net.github.map((c) => c.url.split("/workflows/")[1])).toEqual([
      "maintenance.yml/dispatches",
      "backup.yml/dispatches",
    ]);
    // A different night, outage past the 60 minute window for maintenance only.
    resetClockCache();
    net.github.length = 0;
    await tick(at("2026-06-16", "23:45"));
    expect(net.github.map((c) => c.url.split("/workflows/")[1])).toEqual(["backup.yml/dispatches"]);
  });

  it("nightly jobs also run on a weekend; the daily rollup counts them", async () => {
    enable();
    await tick(at(SAT, "23:00"));
    expect(net.github).toHaveLength(2);
    expect(rollups()[0]).toMatchObject({ scheduled_for: SAT, items_processed: 2 });
  });

  it("a failed dispatch is recorded and retried next minute, capped at MAX_ATTEMPTS", async () => {
    enable();
    net.githubPlan = [500, 403, 422];
    const t = at(MON, "22:30");
    const s1 = await tick(t);
    expect(s1.failed).toEqual(["maintenance"]);
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toMatchObject({
      status: "failed",
      concurrency_key: `dispatch-failed:maintenance:${MON}:1`,
      error_summary: "dispatch maintenance HTTP 500",
    });
    await tick(t + 60_000);
    await tick(t + 120_000);
    expect(failures()).toHaveLength(3);
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!)).toMatchObject({ s: "failed", n: 3 });
    // no fourth attempt
    await tick(t + 180_000);
    await tick(t + 240_000);
    expect(net.github.filter((c) => c.url.includes("maintenance.yml"))).toHaveLength(3);
    expect(failures()).toHaveLength(3);
    expect(rollups()[0].items_processed).toBe(0);
  });

  it("failure then success: retry succeeds on attempt 2", async () => {
    enable();
    net.githubPlan = ["throw"];
    const t = at(MON, "22:30");
    expect((await tick(t)).failed).toEqual(["maintenance"]);
    expect(failures()[0].error_summary).toBe("dispatch maintenance Error");
    expect((await tick(t + 60_000)).dispatched).toEqual(["maintenance"]);
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!)).toMatchObject({
      s: "dispatched",
      n: 2,
    });
    expect(rollups()[0].items_processed).toBe(1);
  });

  it("a crashed attempt (claim with no result) is retried after it goes stale", async () => {
    enable();
    const t = at(MON, "22:30");
    const claim = JSON.stringify({ s: "claimed", n: 1, at: new Date(t).toISOString() });
    db.prepare("INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')").run(
      slotKey("maintenance", MON),
      claim,
    );
    await tick(t + 60_000);
    expect(net.github).toHaveLength(0);
    await tick(t + CLAIM_STALE_MS);
    expect(net.github).toHaveLength(1);
    expect(JSON.parse(stateRow(slotKey("maintenance", MON))!)).toMatchObject({
      s: "dispatched",
      n: 2,
    });
  });

  it("the token never appears in logs, run records, state, or failure details", async () => {
    enable();
    net.githubPlan = ["throw", 401];
    const t = at(MON, "22:30");
    await tick(t);
    await tick(t + 60_000);
    const everything = JSON.stringify([
      logs,
      rows(db, "SELECT * FROM run_record"),
      rows(db, "SELECT * FROM worker_state"),
    ]);
    expect(everything).not.toContain("TOPSECRET");
    expect(everything).not.toContain("praxis-main-secret-host");
  });

  it("unknown workflow in an enabled slot is refused: no GitHub call, a failed record", async () => {
    enable();
    const evil: Slot = {
      ...AU_SLOTS.find((s) => s.id === "backup")!,
      id: "evil",
      workflow: "deploy-production.yml",
    };
    const s = await tick(at(MON, "23:00"), ENV, [evil]);
    expect(s.dispatched).toEqual([]);
    expect(s.failed).toEqual(["evil"]);
    expect(net.github).toHaveLength(0);
    expect(failures()[0].error_summary).toBe("dispatch evil workflow-not-allowed");
  });

  it("the ingest slot dispatches ingest-batch1.yml with ref release at 17:30, once", async () => {
    enable();
    const s = await tick(at(MON, "17:30"));
    expect(s.dispatched).toEqual(["ingest-batch1"]);
    expect(net.github).toHaveLength(1);
    expect(net.github[0].url).toContain("/actions/workflows/ingest-batch1.yml/dispatches");
    expect(JSON.parse(net.github[0].body)).toEqual({ ref: "release" });
    resetClockCache();
    expect((await tick(at(MON, "17:31"))).dispatched).toEqual([]);
    expect(net.github).toHaveLength(1);
  });

  it("the ingest slot is inert while the dispatch switch is off (D-060)", async () => {
    const s = await tick(at(MON, "17:30"));
    expect(s.dispatched).toEqual([]);
    expect(net.github).toHaveLength(0);
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
  });

  it("the ingest slot waits for market mode and a trading day", async () => {
    enable();
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    expect((await tick(at(MON, "17:30"))).dispatched).toEqual([]);
    resetClockCache();
    db.prepare("UPDATE market SET mode = 'data_only' WHERE code = 'AU'").run();
    expect((await tick(at("2026-10-17", "17:30"))).dispatched).toEqual([]); // a Saturday
    expect(net.github).toHaveLength(0);
  });

  it("an enabled trading-day slot respects a seeded holiday and an early-close day", async () => {
    enable();
    const batch: Slot[] = AU_SLOTS.map((s) =>
      s.id === "ingest-batch1" ? { ...s, enabled: true, workflow: "maintenance.yml" } : s,
    );
    // 2026-12-25 is a seeded holiday; 2026-12-24 is a seeded early close (still a trading day).
    const hol = await tick(at("2026-12-25", "17:30", 11), ENV, batch);
    expect(hol.dispatched).toEqual([]);
    resetClockCache();
    const early = await tick(at("2026-12-24", "17:30", 11), ENV, batch);
    expect(early.dispatched).toEqual(["ingest-batch1"]);
    expect(net.github).toHaveLength(1);
  });

  it("market_mode off stops market-bound dispatch only", async () => {
    enable();
    const batch: Slot[] = AU_SLOTS.map((s) =>
      s.id === "ingest-batch1" ? { ...s, enabled: true, workflow: "maintenance.yml" } : s,
    );
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    expect((await tick(at(MON, "17:30"), ENV, batch)).dispatched).toEqual([]);
    resetClockCache();
    expect((await tick(at(MON, "23:00"), ENV, batch)).dispatched).toEqual([
      "maintenance",
      "backup",
    ]);
  });

  it("refs: production release, staging main, anything else nothing", async () => {
    enable();
    const t = at(MON, "22:30");
    await tick(t);
    expect(JSON.parse(net.github[0].body)).toEqual({ ref: "release" });
    net.github.length = 0;
    resetClockCache();
    await tick(at("2026-06-16", "22:30"), { ...ENV, PRAXIS_ENV: "staging" });
    expect(JSON.parse(net.github[0].body)).toEqual({ ref: "main" });
    net.github.length = 0;
    resetClockCache();
    const calls = net.calls.length;
    await tick(at("2026-06-17", "22:30"), { ...ENV, PRAXIS_ENV: "preview" });
    expect(net.calls.length).toBe(calls);
  });

  it("missing token fails visibly without a GitHub call; missing DB does nothing", async () => {
    enable();
    const s = await tick(at(MON, "22:30"), { ...ENV, GITHUB_DISPATCH_TOKEN: undefined });
    expect(s.failed).toEqual(["maintenance"]);
    expect(net.github).toHaveLength(0);
    expect(failures()[0].error_summary).toBe("dispatch maintenance token-missing");
    resetClockCache();
    const before = net.calls.length;
    const s2 = await tick(at(MON, "22:30"), { ...ENV, TURSO_MAIN_TOKEN: undefined });
    expect(s2.requests).toBe(0);
    expect(net.calls.length).toBe(before);
  });

  it("a database failure never throws and dispatches nothing", async () => {
    enable();
    net.failPipeline = true;
    const s = await tick(at(MON, "22:30"));
    expect(s).toEqual({ requests: 1, dispatched: [], failed: [] });
    expect(net.github).toHaveLength(0);
    expect(logs.join("\n")).toContain("clock: db error");
  });
});

describe("daily rollup and per-tick cost (DAT-141, PLT-070)", () => {
  it("idle minutes cost no database request once the isolate knows today's rollup", async () => {
    const t = at(MON, "12:00");
    await tick(t);
    expect(net.pipelines).toBe(1);
    for (let i = 1; i <= 60; i++) await tick(t + i * 60_000);
    expect(net.pipelines).toBe(1);
    expect(rollups()).toHaveLength(1);
    expect(rollups()[0].items_processed).toBe(0);
  });

  it("a cold isolate on an idle minute does at most 1 request (one statement, no read of state)", async () => {
    for (let i = 0; i < 10; i++) {
      resetClockCache();
      const before = net.pipelines;
      await tick(at(MON, "12:00") + i * 60_000);
      expect(net.pipelines - before).toBeLessThanOrEqual(1);
    }
    expect(rollups()).toHaveLength(1); // the conditional insert keeps one record per date
  });

  it("a new date starts a new rollup", async () => {
    await tick(at(MON, "12:00"));
    await tick(at("2026-06-16", "12:00"));
    expect(
      rollups()
        .map((r) => r.scheduled_for)
        .sort(),
    ).toEqual([MON, "2026-06-16"]);
  });

  it("window ticks with the switch off cost exactly 1 request each and write nothing", async () => {
    const t = at(MON, "23:00");
    await tick(t);
    const before = net.pipelines;
    for (let i = 1; i <= 5; i++) await tick(t + i * 60_000);
    expect(net.pipelines - before).toBe(5);
    expect(rows(db, "SELECT key FROM worker_state")).toEqual([]);
  });

  it("a normal dispatching night: at most 3 DB requests in a tick, 2 writes to run_record", async () => {
    enable();
    const s = await tick(at(MON, "23:00"));
    expect(s.dispatched).toEqual(["maintenance", "backup"]);
    expect(s.requests).toBe(3);
    // one rollup insert + 2 rollup updates (the records are per-day, a few writes a day)
    expect(rollups()).toHaveLength(1);
    expect(failures()).toHaveLength(0);
  });
});

describe("scheduled handler wiring", () => {
  it("heartbeat, then the clock, then the self-check; never throws", async () => {
    const t = at(MON, "12:00");
    const env = { ...ENV, APP_BASE_URL: "https://praxis-app-ssbn.vercel.app" };
    vi.stubGlobal("fetch", net.f);
    await expect(
      worker.scheduled({ scheduledTime: t } as ScheduledController, env),
    ).resolves.toBeUndefined();
    expect(JSON.parse(logs[0])).toMatchObject({ kind: "heartbeat" });
    expect(rollups()).toHaveLength(1);
    vi.unstubAllGlobals();
  });
  it("a Worker with no secrets still returns cleanly", async () => {
    await expect(
      worker.scheduled({ scheduledTime: at(MON, "23:00") } as ScheduledController, {
        PRAXIS_ENV: "production",
      }),
    ).resolves.toBeUndefined();
  });
});
