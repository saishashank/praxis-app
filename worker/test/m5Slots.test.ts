// M5 T14 (TST-103, TST-123, TST-124; D-059, D-060, D-096 #41, D-103, D-107, D-108): the Worker runs
// every M5 slot against real SQLite (Turso fake) on the days around both Sydney clock changes, and
// across day types (trading day, weekend, public holiday, 24/31 Dec half days) with the dispatch
// switch on and off. The pure instant tables are in tests/time/m5Slots.test.ts. Nothing touches a
// network: the app, ASX and GitHub are local fakes. All M5 slots are disabled in the shipped table;
// the tests enable copies, except the TST-124 test which enables the shipped objects for one test.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASX_ANNOUNCEMENTS_URL } from "../src/asx/request";
import { pollDue } from "../src/asx/slots";
import { candidateSlots, resetClockCache } from "../src/clock";
import worker from "../src/index";
import { sydneyLocal } from "../src/localtime";
import { routeSlotsDue, runRoutes, type RouteEnv } from "../src/routes";
import { AU_SLOTS, type Slot } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const UA = "praxis-sentinel-test (contact: owner@example.test)";
const MIN = 60_000;
// M8 T17: v8 coverage instrumentation slows the CPU measurements; the coverage job sets PRAXIS_COVERAGE_RUN=1.
const COVERAGE_SLACK = process.env.PRAXIS_COVERAGE_RUN === "1" ? 4 : 1;
// R3-I4 (D-820): the two PLT-070 CPU-budget tests below are TIMING checks. Names carry "[timing]"; in CI only
// (CI=true) each gets one retry, so a noisy shared runner does not turn the release gate red. The budget and
// the margin are unchanged, and the measured median is logged on every run so a trend stays visible.
const TIMING_RETRY = process.env.CI ? 1 : 0;
const ENV: RouteEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: SECRET,
};
// M17 slots (quote-poll, intraday-scan) have their own tests (m17Slots.test.ts); these suites cover the M5 table.
const M17_SLOTS = new Set(["quote-poll", "intraday-scan"]);
const on: Slot[] = AU_SLOTS.filter((s) => !M17_SLOTS.has(s.id)).map((s) =>
  s.runner === "route" ? { ...s, enabled: true, requiresListing: false } : s,
);

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** Local Sydney time to a UTC instant for a fixed offset (10 = AEST, 11 = AEDT). */
const at = (date: string, time: string, offset: number) => {
  const [h, m] = time.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};
const iso = (ms: number) => new Date(ms).toISOString();

type AppCall = { t: number; slot: string; d: string; attempt: number | null; url: string };
let db: DatabaseSync;
let net: Net;
let appCalls: AppCall[];
let appStatus: number | "throw";
let asxCalls: number;
let now: number; // the tick time the fake app stamps its calls with
let f: typeof fetch;

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const dispatchOn = () => setState("dispatch_enabled", '"1"');
const marketMode = (mode: string) =>
  db.prepare("UPDATE market SET mode = ? WHERE code = 'AU'").run(mode);
const deps = (t: number) => ({ fetch: f, nowMs: () => t });
const tick = (t: number, slots: readonly Slot[] = on, env: RouteEnv = ENV) => {
  now = t;
  return runRoutes(env, t, deps(t), slots);
};

beforeEach(() => {
  db = makeDb({ sentinel: false });
  net = makeNet(db);
  appCalls = [];
  appStatus = 200;
  asxCalls = 0;
  now = 0;
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(APP)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      appCalls.push({
        t: now,
        slot: String(body.slot ?? body.purpose),
        d: String(body.d),
        attempt: typeof body.attempt === "number" ? body.attempt : null,
        url,
      });
      if (appStatus === "throw") throw new Error("boom");
      return Response.json({ ok: true }, { status: appStatus });
    }
    if (url.startsWith("https://www.asx.com.au/")) {
      asxCalls++;
      return new Response(JSON.stringify({ data: [{ id: "x1", code: "ZZAA" }] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"v1"' },
      });
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---- TST-103: full-day sweeps around both clock changes -----------------------------------------

const DAYS: { date: string; offset: 10 | 11; weekend: boolean }[] = [
  { date: "2026-10-02", offset: 10, weekend: false },
  { date: "2026-10-03", offset: 10, weekend: true },
  { date: "2026-10-04", offset: 11, weekend: true }, // AEST -> AEDT at 02:00
  { date: "2026-10-05", offset: 11, weekend: false },
  { date: "2027-04-02", offset: 11, weekend: false },
  { date: "2027-04-03", offset: 11, weekend: true },
  { date: "2027-04-04", offset: 10, weekend: true }, // AEDT -> AEST at 03:00
  { date: "2027-04-05", offset: 10, weekend: false },
];

/** Run the Worker's route runner on every UTC minute of a Sydney date. */
async function sweep(date: string, slots: readonly Slot[] = on): Promise<number> {
  const [y, m, d] = date.split("-").map(Number);
  const from = Date.UTC(y, m - 1, d) - 14 * 60 * MIN;
  let ticks = 0;
  for (let t = from; t < from + 52 * 60 * MIN; t += MIN) {
    if (sydneyLocal(t).date !== date) continue;
    ticks++;
    await tick(t, slots);
  }
  return ticks;
}

describe("TST-103: the Worker posts every M5 slot once per day on and around both clock changes", () => {
  const expected = (date: string, offset: number, weekend: boolean) => {
    const out: string[] = [`morning@${iso(at(date, "08:00", offset))}`];
    if (!weekend) out.push(`pre-open@${iso(at(date, "09:54", offset))}`);
    for (const x of [
      "20:00",
      "20:05",
      "20:10",
      "20:15",
      "20:20",
      "20:25",
      "20:30",
      "20:35",
      "20:40",
      "20:45",
    ]) {
      out.push(`evening-review@${iso(at(date, x, offset))}`);
    }
    for (const x of ["21:00", "21:15", "21:30", "21:45", "22:00"]) {
      out.push(`evening-review-late@${iso(at(date, x, offset))}`);
    }
    return out.sort();
  };

  for (const day of DAYS) {
    it(`${day.date}: exact UTC instants, one post per tick, review date = the Sydney date`, async () => {
      dispatchOn();
      marketMode("full");
      const ticks = await sweep(day.date);
      expect(ticks).toBe(
        day.date === "2026-10-04" ? 1380 : day.date === "2027-04-04" ? 1500 : 1440,
      );
      expect(appCalls.map((c) => `${c.slot}@${iso(c.t)}`).sort()).toEqual(
        expected(day.date, day.offset, day.weekend),
      );
      expect(new Set(appCalls.map((c) => c.d))).toEqual(new Set([day.date]));
      // pre-open succeeded, so the retry never posted and no failure was recorded
      expect(appCalls.some((c) => c.slot === "pre-open-retry")).toBe(false);
      expect(rows(db, "SELECT 1 FROM run_record WHERE job = 'worker-route'")).toEqual([]);
      // single-shot slots left exactly one state row each for the day
      expect(
        rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%' ORDER BY key").map(
          (r) => r.key,
        ),
      ).toEqual(
        day.weekend
          ? [`slot:morning:${day.date}`]
          : [`slot:morning:${day.date}`, `slot:pre-open:${day.date}`],
      );
    });
  }

  it("re-running the whole fall-back day from a cold isolate posts nothing a second time (single-shot) and the review route is the only repeat", async () => {
    dispatchOn();
    await sweep("2027-04-04");
    const first = appCalls.filter((c) => c.slot === "morning").length;
    appCalls.length = 0;
    await sweep("2027-04-04");
    expect(appCalls.filter((c) => c.slot === "morning")).toHaveLength(0);
    expect(first).toBe(1);
  });
});

describe("no double fire across the fall-back hour, no miss across spring-forward (single-shot state)", () => {
  const syn = (over: Partial<Slot> = {}): Slot => ({
    ...AU_SLOTS.find((s) => s.id === "morning")!,
    id: "syn",
    time: "02:30",
    minute: 150,
    catchUpMin: 60,
    enabled: true,
    requiresListing: false,
    ...over,
  });

  it("a single-shot slot at 02:30 is caught up at 03:00 on the spring-forward day, posted once", async () => {
    dispatchOn();
    await sweep("2026-10-04", [syn()]);
    expect(appCalls).toHaveLength(1);
    expect(iso(appCalls[0].t)).toBe("2026-10-03T16:00:00.000Z"); // 03:00 AEDT
    expect(appCalls[0].d).toBe("2026-10-04");
  });

  it("a single-shot slot at 02:30 posts once on the fall-back day, at the first 02:30 (AEDT)", async () => {
    dispatchOn();
    await sweep("2027-04-04", [syn()]);
    expect(appCalls).toHaveLength(1);
    expect(iso(appCalls[0].t)).toBe("2027-04-03T15:30:00.000Z");
  });

  it("a failed single-shot attempt in the first pass is not retried in the repeated hour beyond maxAttempts", async () => {
    dispatchOn();
    appStatus = 503;
    await sweep("2027-04-04", [syn({ maxAttempts: 1 })]);
    expect(appCalls).toHaveLength(1);
    expect(rows(db, "SELECT status FROM run_record WHERE job = 'worker-route'")).toEqual([
      { status: "failed" },
    ]);
  });

  it("an idle second pass of the repeated hour costs no database request for the real M5 slots", async () => {
    dispatchOn();
    const before = net.pipelines;
    // 02:00-02:59 occurs twice on 2027-04-04: no M5 slot is due in either pass
    for (
      let t = Date.parse("2027-04-03T15:00:00Z");
      t < Date.parse("2027-04-03T17:00:00Z");
      t += MIN
    ) {
      await tick(t);
    }
    expect(net.pipelines).toBe(before);
    expect(appCalls).toHaveLength(0);
  });
});

describe("catch-up windows and retries (D-103, D-108)", () => {
  const MON = "2026-10-19";
  beforeEach(() => {
    dispatchOn();
    marketMode("full");
  });

  it("pre-open succeeds at 09:54: no second attempt at 09:55..09:58", async () => {
    for (const x of ["09:54", "09:55", "09:56", "09:57", "09:58", "09:59"])
      await tick(at(MON, x, 11));
    expect(appCalls.map((c) => `${c.slot}:${c.attempt}`)).toEqual(["pre-open:1"]);
  });

  it("pre-open fails at 09:54 (503): one attempt only, then pre-open-retry at 09:58 as attempt 2, and a failed record each", async () => {
    appStatus = 503;
    for (const x of ["09:54", "09:55", "09:56", "09:57", "09:58", "09:59", "10:00"]) {
      await tick(at(MON, x, 11));
    }
    expect(appCalls.map((c) => `${c.slot}:${c.attempt}@${hm(sydneyLocal(c.t).minute)}`)).toEqual([
      "pre-open:1@09:54",
      "pre-open-retry:2@09:58",
    ]);
    expect(
      rows(db, "SELECT concurrency_key FROM run_record WHERE job = 'worker-route' ORDER BY id"),
    ).toEqual([
      { concurrency_key: `route-failed:pre-open:${MON}:1` },
      { concurrency_key: `route-failed:pre-open-retry:${MON}:1` },
    ]);
  });

  it("Worker outage until 09:57: pre-open still posts (catch-up 3 min) and the retry stays quiet; from 09:58 only the retry runs", async () => {
    await tick(at(MON, "09:57", 11));
    await tick(at(MON, "09:58", 11));
    expect(appCalls.map((c) => c.slot)).toEqual(["pre-open"]);
    appCalls.length = 0;
    db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
    await tick(at(MON, "09:58", 11));
    await tick(at(MON, "10:00", 11)); // window closed
    expect(appCalls.map((c) => `${c.slot}:${c.attempt}`)).toEqual(["pre-open-retry:2"]);
  });

  it("morning: down until 08:30 still posts once; 08:31 is too late; a second tick the same day does not repost", async () => {
    await tick(at(MON, "08:30", 11));
    await tick(at(MON, "08:31", 11));
    expect(appCalls.map((c) => c.slot)).toEqual(["morning"]);
    appCalls.length = 0;
    db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
    await tick(at(MON, "08:31", 11));
    expect(appCalls).toEqual([]);
  });

  it("morning retries a failed post on the next minute, three attempts in all, within the window", async () => {
    appStatus = 503;
    for (let i = 0; i < 6; i++) await tick(at(MON, "08:00", 11) + i * MIN);
    expect(appCalls.filter((c) => c.slot === "morning")).toHaveLength(3);
    appStatus = 200;
    await tick(at(MON, "08:07", 11));
    expect(appCalls.filter((c) => c.slot === "morning")).toHaveLength(3);
  });

  it("evening review failure is retried by the next 5-minute tick without state; then it succeeds", async () => {
    appStatus = 503;
    await tick(at(MON, "20:00", 11));
    appStatus = 200;
    await tick(at(MON, "20:05", 11));
    expect(appCalls.map((c) => hm(sydneyLocal(c.t).minute))).toEqual(["20:00", "20:05"]);
    expect(rows(db, "SELECT 1 FROM run_record WHERE job = 'worker-route'")).toHaveLength(1); // V2-B1: one failure record per recurring slot and day
  });
});

// ---- TST-123 matrix: slot x day type x switch -------------------------------------------------

describe("TST-123 matrix: slot x (trading day, weekend, holiday, 24 and 31 Dec half days) x (dispatch switch on/off)", () => {
  // [date, offset, trading?]: the seeded calendar (migration 0005) marks 2026-12-25 a holiday and
  // 24/31 Dec early closes (still trading days).
  const DAYTYPES = [
    ["trading day", "2026-10-19", 11, true],
    ["weekend (Saturday)", "2026-10-17", 11, false],
    ["weekend (Sunday)", "2026-10-18", 11, false],
    ["public holiday (Christmas Day)", "2026-12-25", 11, false],
    ["half day (24 Dec)", "2026-12-24", 11, true],
    ["half day (31 Dec)", "2026-12-31", 11, true],
  ] as const;
  // slot id -> [local tick, runs on trading days only, needs the flush marker]
  const SLOTS = [
    ["alert-flush", "07:01", true],
    ["morning", "08:00", false],
    ["pre-open", "09:54", true],
    ["pre-open-retry", "09:58", true],
    ["evening-review", "20:00", false],
    ["evening-review-late", "21:00", false],
  ] as const;

  for (const [label, date, offset, trading] of DAYTYPES) {
    for (const [id, time, tradingOnly] of SLOTS) {
      for (const sw of [true, false]) {
        const fires = sw && (!tradingOnly || trading);
        it(`${label} ${date}: ${id} at ${time} with switch ${sw ? "on" : "off"} -> ${fires ? "fires" : "skips"}`, async () => {
          if (sw) dispatchOn();
          marketMode("full");
          // alert-flush posts only once a flush is due (design 4.3)
          setState("alert_flush_due", JSON.stringify("2020-01-01T00:00:00.000Z"));
          const t = at(date, time, offset);
          const s = await tick(t);
          if (fires) {
            expect(s.posted).toEqual([id]);
            expect(appCalls).toHaveLength(1);
            expect(appCalls[0]).toMatchObject({ slot: id, d: date });
          } else {
            expect(s.posted).toEqual([]);
            expect(appCalls).toHaveLength(0);
          }
        });
      }
    }
  }

  it("market mode off stops only the market-bound pre-open slots on a trading day", async () => {
    dispatchOn();
    marketMode("off");
    setState("alert_flush_due", JSON.stringify("2020-01-01T00:00:00.000Z"));
    const date = "2026-10-19";
    const got: string[] = [];
    for (const [id, time] of [
      ["alert-flush", "07:01"],
      ["morning", "08:00"],
      ["pre-open", "09:54"],
      ["pre-open-retry", "09:58"],
      ["evening-review", "20:00"],
      ["evening-review-late", "21:00"],
    ] as const) {
      const s = await tick(at(date, time, 11));
      if (s.posted.includes(id)) got.push(id);
    }
    expect(got).toEqual(["alert-flush", "morning", "evening-review", "evening-review-late"]);
  });

  it("an alert-flush with no due marker, or one in the future, never posts, on any day type", async () => {
    dispatchOn();
    marketMode("full");
    const t = at("2026-10-19", "07:01", 11);
    expect((await tick(t)).posted).toEqual([]);
    setState("alert_flush_due", JSON.stringify(new Date(t + 5 * MIN).toISOString()));
    expect((await tick(t)).posted).toEqual([]);
    setState("alert_flush_due", JSON.stringify(new Date(t).toISOString()));
    expect((await tick(t)).posted).toEqual(["alert-flush"]);
  });
});

describe("Sentinel poll path across day types and clock changes (TST-103, TST-123)", () => {
  const PENV = { ...ENV, ASX_LIVE: "1", ASX_USER_AGENT: UA };
  const poll = async (t: number) => {
    const { runAsx } = await import("../src/asx/slots");
    return runAsx(PENV, t, deps(t));
  };
  beforeEach(() => {
    db = makeDb();
    net = makeNet(db);
    setState("asx_enabled", '"1"');
    marketMode("full");
  });

  it.each([
    ["trading day", "2026-10-19", 11, true],
    ["weekend", "2026-10-17", 11, false],
    ["public holiday", "2026-12-25", 11, false],
    ["half day 24 Dec", "2026-12-24", 11, true],
    ["half day 31 Dec", "2026-12-31", 11, true],
    ["first Monday after AEDT starts", "2026-10-05", 11, true],
    ["first Monday after AEST starts", "2027-04-05", 10, true],
    ["spring-forward Sunday", "2026-10-04", 11, false],
    ["fall-back Sunday", "2027-04-04", 10, false],
  ] as const)("%s %s: 10:00 poll %s", async (_l, date, offset, calls) => {
    const t = at(date, "10:00", offset);
    expect(pollDue(sydneyLocal(t))).toBe(
      !["weekend", "spring-forward Sunday", "fall-back Sunday"].includes(_l),
    );
    await poll(t);
    expect(asxCalls).toBe(calls ? 1 : 0);
  });

  it("every poll of a day, on both sides of the change, is 4 minutes apart in UTC", async () => {
    for (const [date, offset] of [
      ["2026-10-05", 11],
      ["2027-04-05", 10],
    ] as const) {
      const ts: number[] = [];
      for (let m = 7 * 60; m <= 19 * 60 + 30; m++) {
        const t = at(date, hm(m), offset);
        if (pollDue(sydneyLocal(t))) ts.push(t);
      }
      expect(ts).toHaveLength(188);
      expect(new Set(ts.slice(1).map((x, i) => x - ts[i]))).toEqual(new Set([4 * MIN]));
    }
  });
});

// ---- TST-124: all M5 slots enabled, a busy minute ---------------------------------------------------

describe("TST-124: the scheduled handler with every slot enabled stays inside the CPU and subrequest budgets", () => {
  type Saved = {
    s: Slot;
    enabled: boolean;
    requiresListing?: boolean;
    time: string;
    minute: number;
    until?: string;
    catchUpMin: number;
  };
  let saved: Saved[] = [];
  const mutable = (s: Slot) =>
    s as unknown as {
      enabled: boolean;
      requiresListing?: boolean;
      time: string;
      minute: number;
      until?: string;
      catchUpMin: number;
    };
  const enableAll = () => {
    saved = AU_SLOTS.map((s) => ({
      s,
      enabled: s.enabled,
      requiresListing: s.requiresListing,
      time: s.time,
      minute: s.minute,
      until: s.until,
      catchUpMin: s.catchUpMin,
    }));
    for (const s of AU_SLOTS) {
      mutable(s).enabled = true;
      mutable(s).requiresListing = false; // M8 T8: no list in these tests, so nothing may hold a slot back
    }
  };
  /** Move every non-polling slot to 10:00 so they are all due in one minute. */
  const pileUp = () => {
    for (const s of AU_SLOTS) {
      if (s.id === "asx-poll" || s.id === "universe") continue;
      const m = mutable(s);
      m.time = "10:00";
      m.minute = 600;
      m.until = s.until === undefined ? undefined : "10:00";
      m.catchUpMin = 5;
    }
  };
  afterEach(() => {
    for (const x of saved) {
      const m = mutable(x.s);
      m.enabled = x.enabled;
      m.requiresListing = x.requiresListing;
      m.time = x.time;
      m.minute = x.minute;
      m.until = x.until;
      m.catchUpMin = x.catchUpMin;
    }
    saved = [];
  });

  const FULL_ENV = {
    ...ENV,
    GITHUB_DISPATCH_TOKEN: TOKEN,
    ASX_LIVE: "1",
    ASX_USER_AGENT: UA,
  };

  it("restores the shipped table after the tests (no slot leaks as enabled)", () => {
    // M8 T8: the route slots are available but listed-only
    expect(
      AU_SLOTS.filter((s) => s.runner === "route").every((s) => s.enabled === s.requiresListing),
    ).toBe(true);
  });

  async function measure(t: number, runs: number) {
    const cpu: number[] = [];
    const subs: number[] = [];
    for (let i = 0; i < runs; i++) {
      db = makeDb({ sentinel: true });
      net = makeNet(db);
      dispatchOn();
      marketMode("full");
      setState("asx_enabled", '"1"');
      setState("alert_flush_due", JSON.stringify("2020-01-01T00:00:00.000Z"));
      resetClockCache();
      appCalls.length = 0;
      let subrequests = 0;
      let inside = 0; // CPU used by the fake network and database (not the Worker's own work)
      vi.stubGlobal("fetch", (async (i2: string | URL | Request, init?: RequestInit) => {
        subrequests++;
        const c0 = process.cpuUsage();
        try {
          return await f(i2, init);
        } finally {
          const c1 = process.cpuUsage(c0);
          inside += c1.user + c1.system;
        }
      }) as typeof fetch);
      now = t;
      const before = process.cpuUsage();
      await worker.scheduled({ scheduledTime: t } as ScheduledController, FULL_ENV as never);
      const used = process.cpuUsage(before);
      vi.unstubAllGlobals();
      cpu.push(Math.max(0, used.user + used.system - inside) / 1000); // ms of Worker-side CPU
      subs.push(subrequests);
    }
    cpu.sort((a, b) => a - b);
    return {
      median: cpu[Math.floor(cpu.length / 2)],
      max: cpu[cpu.length - 1],
      subs: Math.max(...subs),
    };
  }

  it(
    "[timing] the busiest minute of a real trading day, with every slot enabled, is cheap",
    { retry: TIMING_RETRY },
    async () => {
      enableAll();
      const date = "2026-10-19";
      let best = { n: -1, m: 0 };
      for (let m = 0; m < 1440; m++) {
        const l = sydneyLocal(at(date, hm(m), 11));
        const n =
          candidateSlots(l, AU_SLOTS).length +
          routeSlotsDue(l, AU_SLOTS).length +
          (pollDue(l) ? 1 : 0);
        if (n > best.n) best = { n, m };
      }
      expect(best.n).toBeGreaterThanOrEqual(3);
      await measure(at(date, hm(best.m), 11), 3); // warm-up (module and JIT)
      const r = await measure(at(date, hm(best.m), 11), 9);
      console.info(
        `[timing] busiest minute: median ${r.median.toFixed(2)} ms CPU, ${r.subs} subrequests`,
      );
      expect(r.subs).toBeLessThanOrEqual(50 - 10); // PLT-070: 50 subrequests, margin of 10
      expect(r.median).toBeLessThan(10 * 0.5 * COVERAGE_SLACK); // PLT-070: 10 ms CPU; assert half with margin
    },
  );

  it(
    "[timing] a simulated pile-up: every M5 route slot, the clock, the ASX poll and the self-check due in the same minute",
    { retry: TIMING_RETRY },
    async () => {
      enableAll();
      pileUp();
      const t = at("2026-10-19", "10:00", 11); // Monday, a poll minute
      const l = sydneyLocal(t);
      expect(pollDue(l)).toBe(true);
      const routes = routeSlotsDue(l, AU_SLOTS).map((s) => s.id);
      expect(routes).toEqual(
        expect.arrayContaining([
          "pre-open",
          "morning",
          "evening-review",
          "evening-review-late",
          "alert-flush",
        ]),
      );
      // alert-flush needs an odd minute: 10:00 is even, so move it onto the same minute like the rest
      expect(candidateSlots(l, AU_SLOTS).length).toBeGreaterThanOrEqual(5);
      await measure(t, 3);
      const r = await measure(t, 9);
      console.info(`[timing] pile-up: median ${r.median.toFixed(2)} ms CPU, ${r.subs} subrequests`);
      expect(r.subs).toBeLessThanOrEqual(50);
      expect(r.median).toBeLessThan(10 * 0.8 * COVERAGE_SLACK);
      // and the work really happened: app posts, GitHub dispatches and the ASX poll all ran
      expect(appCalls.length).toBeGreaterThanOrEqual(3);
      expect(net.github.length).toBeGreaterThanOrEqual(5);
      expect(asxCalls).toBeGreaterThanOrEqual(1);
    },
  );

  it("a day of ticks with every slot enabled makes at most 720 ASX requests (TST-124) and one per poll slot", async () => {
    enableAll();
    let polls = 0;
    for (let m = 0; m < 1440; m++) {
      if (pollDue(sydneyLocal(at("2026-10-19", hm(m), 11)))) polls++;
    }
    expect(polls).toBe(188);
    expect(polls + 1).toBeLessThanOrEqual(720); // + the universe import
  });
});
