// M18 TST-136 (D-968): the WALL-CLOCK variants of the two PLT-070 CPU-budget checks, moved out of
// m5Slots.test.ts (whose versions now count work units: subrequests, dispatches, ticks). They measure the
// Worker's own CPU per minute with process.cpuUsage, so they are noisy on a shared runner: they never run in
// the default suite (not under test/) and never retry. The non-blocking "Timing report" CI step runs them:
//   cd worker && npx vitest run --config vitest.timing.config.mts
// The measured median is printed on every run so a trend stays visible.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollDue } from "../src/asx/slots";
import { resetClockCache } from "../src/clock";
import worker from "../src/index";
import { sydneyLocal } from "../src/localtime";
import { routeSlotsDue, runRoutes, type RouteEnv } from "../src/routes";
import { AU_SLOTS, type Slot } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, type Net } from "../test/fakeTurso";
import { candidateSlots } from "../src/clock";

const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const UA = "praxis-sentinel-test (contact: owner@example.test)";
// v8 coverage instrumentation slows the CPU measurements; the coverage job sets PRAXIS_COVERAGE_RUN=1.
const MIN = 60_000;
const COVERAGE_SLACK = process.env.PRAXIS_COVERAGE_RUN === "1" ? 4 : 1;

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
  it("[timing] the busiest minute of a real trading day, with every slot enabled, is cheap", async () => {
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
  });
  it("[timing] a simulated pile-up: every M5 route slot, the clock, the ASX poll and the self-check due in the same minute", async () => {
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
  });
});
