// M8 T8 (decisions 32 and 46, TST-103, TST-124): the go-live slots are available but listed-only, the
// monthly bake-off slot, and the CPU/subrequest budget with the runtime list. Nothing touches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateSlots,
  decideWithSkips,
  isFirstSaturday,
  resetClockCache,
  runClock,
  type ClockEnv,
  type Facts,
} from "../src/clock";
import { isDispatchable } from "../src/dispatch";
import worker from "../src/index";
import { sydneyLocal } from "../src/localtime";
import { runRoutes, type RouteEnv } from "../src/routes";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows } from "./fakeTurso";

const ENV: ClockEnv = {
  PRAXIS_ENV: "production",
  GITHUB_DISPATCH_TOKEN: TOKEN,
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
};
const utc = (date: string, time: string, offset: number): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, mi);
};
const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const MIN = 60_000;

let db: ReturnType<typeof makeDb>;
let net: ReturnType<typeof makeNet>;

const tick = (t: number) => runClock(ENV, t, { fetch: net.f, nowMs: () => t });
const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const bakeoffCalls = () => net.github.filter((c) => c.url.includes("/llm-bakeoff.yml/dispatches"));

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  resetClockCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const GO_LIVE_ACTIONS = [
  "arena-close",
  "arena-signals",
  "backfill-history",
  "backfill-prices",
  "replay",
  "kb-archive",
  "llm-bakeoff",
  "watchdog-2040",
  "watchdog-2150",
];
const GO_LIVE_ROUTES = [
  "alert-flush",
  "pre-open",
  "pre-open-retry",
  "evening-review",
  "evening-review-late",
  "morning",
];

describe("the shipped table (decision 32)", () => {
  it("every go-live actions and route slot is available and listed-only", () => {
    for (const id of [...GO_LIVE_ACTIONS, ...GO_LIVE_ROUTES]) {
      const s = AU_SLOTS.find((x) => x.id === id)!;
      expect(s, id).toBeDefined();
      expect([s.enabled, s.requiresListing], id).toEqual([true, true]);
    }
  });
  it("the slots running today need no listing; the slots no runner reads stay disabled", () => {
    for (const id of ["ingest-batch1", "maintenance", "backup"]) {
      const s = AU_SLOTS.find((x) => x.id === id)!;
      expect([s.enabled, s.requiresListing === true], id).toEqual([true, false]);
    }
    for (const id of ["asx-poll", "universe", "decision-cutoff", "late-sweep", "marker-check"]) {
      expect(AU_SLOTS.find((x) => x.id === id)!.enabled, id).toBe(false);
    }
  });
  it("only the listed-only set is the set above (no slot is listed-only by accident)", () => {
    expect(
      AU_SLOTS.filter((s) => s.requiresListing)
        .map((s) => s.id)
        .sort(),
    ).toEqual([...GO_LIVE_ACTIONS, ...GO_LIVE_ROUTES].sort());
  });

  it("a whole Monday with the dispatch switch on and NO list: exactly today's dispatches, no app post", async () => {
    setState("dispatch_enabled", '"1"');
    db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
    const fired: string[] = [];
    const posts: string[] = [];
    const rEnv: RouteEnv = {
      ...ENV,
      APP_BASE_URL: "https://praxis-app.example.test",
      WORKER_HMAC_SECRET: "7".repeat(64),
    };
    const f = (async (i: string | URL | Request, init?: RequestInit) => {
      if (String(i).startsWith("https://praxis-app.example.test")) {
        posts.push(String(i));
        return new Response("{}", { status: 200 });
      }
      return net.f(i, init);
    }) as typeof fetch;
    const day = "2026-10-05";
    for (let m = 0; m < 1440; m++) {
      const t = utc(day, hm(m), 11);
      const s = await runClock(ENV, t, { fetch: f, nowMs: () => t });
      fired.push(...s.dispatched);
      await runRoutes(rEnv, t, { fetch: f, nowMs: () => t });
    }
    expect(fired.sort()).toEqual(["backup", "ingest-batch1", "maintenance"]);
    expect(posts).toEqual([]);
  });
});

describe("the watchdog slots (M8 T13, PLT-071, D-106)", () => {
  const WD: [string, string, string][] = [
    ["watchdog-2040", "20:40", "2040"],
    ["watchdog-2150", "21:50", "2150"],
  ];
  const watchdogCalls = () => net.github.filter((c) => c.url.includes("/watchdog.yml/dispatches"));
  // Days around both clock changes (2026-10-04 AEDT starts, 2027-04-04 AEST starts) and ordinary ones.
  const DAYS: [string, 10 | 11][] = [
    ["2026-10-02", 10],
    ["2026-10-03", 10],
    ["2026-10-04", 11],
    ["2026-10-05", 11],
    ["2026-11-07", 11], // a Saturday: every day, not trading days only
    ["2026-11-08", 11], // a Sunday
    ["2027-04-02", 11],
    ["2027-04-03", 11],
    ["2027-04-04", 10],
    ["2027-04-05", 10],
  ];

  it("are dispatch slots of the allow-listed watchdog.yml, every day, listed-only, with a fixed slot input", () => {
    expect(DISPATCHABLE_WORKFLOWS).toContain("watchdog.yml");
    expect(isDispatchable("watchdog.yml")).toBe(true);
    for (const [id, time, input] of WD) {
      const s = AU_SLOTS.find((x) => x.id === id)!;
      expect(s, id).toBeDefined();
      expect([s.runner, s.workflow, s.time, s.requiresListing, s.enabled], id).toEqual([
        "actions",
        "watchdog.yml",
        time,
        true,
        true,
      ]);
      expect([s.tradingDaysOnly, s.marketBound, s.monthly], id).toEqual([false, false, undefined]);
      expect(s.fixedInputs, id).toEqual({ slot: input });
      expect(s.catchUpMin, id).toBe(id === "watchdog-2040" ? 30 : 20);
    }
  });

  it("held without a list or with a list lacking them; the kill switch off holds all", async () => {
    const t = utc("2026-11-04", "20:40", 11);
    expect((await tick(t)).dispatched).toEqual([]); // kill switch off
    setState("dispatch_enabled", '"1"');
    resetClockCache();
    const absent = await tick(t);
    expect(absent.dispatched).toEqual([]);
    expect(absent.skipped).toContainEqual({ id: "watchdog-2040", reason: "not-released" });
    setState("slots_enabled", JSON.stringify(["backup", "watchdog-2150"]));
    resetClockCache();
    const other = await tick(t);
    expect(other.skipped).toContainEqual({ id: "watchdog-2040", reason: "not-listed" });
    expect(other.dispatched).toEqual([]);
    expect(watchdogCalls()).toHaveLength(0);
  });

  it("listed: each fires exactly once per day across both DST changes, with ref release and its slot input", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["watchdog-2040", "watchdog-2150"]));
    for (const [d, off] of DAYS) {
      for (const [id, time, input] of WD) {
        const before = watchdogCalls().length;
        resetClockCache();
        expect((await tick(utc(d, time, off))).dispatched, `${d} ${id}`).toEqual([id]);
        // the same minute again and the next minutes: still once
        for (const extra of [0, 1, 5, 19]) {
          resetClockCache();
          const [h, m] = time.split(":").map(Number);
          const at = utc(d, hm(h * 60 + m + extra), off);
          expect((await tick(at)).dispatched, `${d} ${id} +${extra}`).toEqual([]);
        }
        const mine = watchdogCalls().slice(before);
        expect(mine, `${d} ${id}`).toHaveLength(1);
        expect(JSON.parse(mine[0]!.body)).toEqual({ ref: "release", inputs: { slot: input } });
      }
    }
    expect(watchdogCalls()).toHaveLength(DAYS.length * 2);
    // never at any other minute of a whole day, and the catch-up window closes after 30 minutes
    resetClockCache();
    expect((await tick(utc("2026-12-01", "21:11", 11))).dispatched).toEqual([]);
    resetClockCache();
    expect((await tick(utc("2026-12-01", "22:11", 11))).dispatched).toEqual([]);
  });

  it("a missed minute is caught up within the window (Worker restarted at 20:55)", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["watchdog-2040"]));
    resetClockCache();
    expect((await tick(utc("2026-11-04", "20:55", 11))).dispatched).toEqual(["watchdog-2040"]);
  });

  it("one database read per tick is unchanged: a held watchdog tick is one request, a dispatching one three", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["backup"]));
    const t = utc("2026-11-04", "20:40", 11);
    const before = net.pipelines;
    await tick(t); // watchdog-2040 due but not listed
    expect(net.pipelines - before).toBe(1);
    const read = net.calls.filter((c) => c.url.endsWith("/v2/pipeline")).at(-1)!;
    const reqs = JSON.parse(read.body).requests as { stmt?: { sql: string } }[];
    expect(reqs.filter((r) => /^s*select/i.test(r.stmt?.sql ?? ""))).toHaveLength(1);
    setState("slots_enabled", JSON.stringify(["watchdog-2040"]));
    resetClockCache();
    const b2 = net.pipelines;
    await tick(t);
    expect(net.pipelines - b2).toBe(3); // read + claim + record
  });
});

describe("the monthly bake-off slot (decision 46)", () => {
  const slot = AU_SLOTS.find((s) => s.id === "llm-bakeoff")!;
  const FIRST_SATURDAYS: [string, 10 | 11][] = [
    ["2026-10-03", 10], // the day before spring forward
    ["2026-11-07", 11],
    ["2026-12-05", 11],
    ["2027-01-02", 11],
    ["2027-04-03", 11], // the day before fall back
    ["2027-05-01", 10],
  ];
  const NOT_FIRST: string[] = [
    "2026-10-10",
    "2026-11-14",
    "2026-11-28",
    "2026-11-06", // a Friday
    "2026-11-08", // a Sunday
    "2026-11-09",
  ];

  it("is a workflow_dispatch slot of an allow-listed workflow, monthly, listed-only", () => {
    expect(slot.runner).toBe("actions");
    expect(slot.workflow).toBe("llm-bakeoff.yml");
    expect(DISPATCHABLE_WORKFLOWS).toContain("llm-bakeoff.yml");
    expect(isDispatchable("llm-bakeoff.yml")).toBe(true);
    expect(slot.monthly).toBe("first-saturday");
    expect(slot.time).toBe("10:00");
    expect(slot.requiresListing).toBe(true);
  });

  it("isFirstSaturday over three years agrees with a calendar count", () => {
    for (
      let t = utc("2026-01-01", "12:00", 11);
      t < utc("2029-01-01", "12:00", 11);
      t += 86_400_000
    ) {
      const l = sydneyLocal(t);
      const d = new Date(
        Date.UTC(+l.date.slice(0, 4), +l.date.slice(5, 7) - 1, +l.date.slice(8, 10)),
      );
      const first = d.getUTCDay() === 6 && d.getUTCDate() <= 7;
      expect(isFirstSaturday(l), l.date).toBe(first);
    }
  });

  it("is due only on the first Saturday of the month", () => {
    for (const [d, off] of FIRST_SATURDAYS) {
      const l = sydneyLocal(utc(d, "10:00", off));
      expect(
        candidateSlots(l).map((s) => s.id),
        d,
      ).toContain("llm-bakeoff");
    }
    for (const d of NOT_FIRST) {
      const l = sydneyLocal(utc(d, "10:00", 11));
      expect(
        candidateSlots(l).map((s) => s.id),
        d,
      ).not.toContain("llm-bakeoff");
    }
  });

  it("disabled by default: without the switch, the list or the inputs it never dispatches", async () => {
    const t = utc("2026-11-07", "10:00", 11);
    setState("bakeoff_inputs", JSON.stringify({ candidates: "google:model-a" }));
    expect((await tick(t)).dispatched).toEqual([]); // kill switch off
    setState("dispatch_enabled", '"1"');
    resetClockCache();
    const absent = await tick(t); // no list: not released
    expect(absent.dispatched).toEqual([]);
    expect(absent.skipped).toContainEqual({ id: "llm-bakeoff", reason: "not-released" });
    setState("slots_enabled", JSON.stringify(["backup"]));
    resetClockCache();
    expect((await tick(t)).skipped).toContainEqual({ id: "llm-bakeoff", reason: "not-listed" });
    expect(bakeoffCalls()).toHaveLength(0);
  });

  it("listed with candidates: dispatches once on the first Saturday with ref release and its inputs", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["llm-bakeoff"]));
    setState(
      "bakeoff_inputs",
      JSON.stringify({
        candidates: "google:model-a groq:model-b",
        trains: "google=no",
        store: "true",
      }),
    );
    for (const [d, off] of FIRST_SATURDAYS) {
      resetClockCache();
      const s = await tick(utc(d, "10:00", off));
      expect(s.dispatched, d).toContain("llm-bakeoff");
      resetClockCache();
      expect((await tick(utc(d, "10:01", off))).dispatched, d).not.toContain("llm-bakeoff"); // once
    }
    expect(bakeoffCalls()).toHaveLength(FIRST_SATURDAYS.length);
    expect(JSON.parse(bakeoffCalls()[0]!.body)).toEqual({
      ref: "release",
      inputs: { candidates: "google:model-a groq:model-b", trains: "google=no", store: "true" },
    });
    // the other Saturdays stay quiet
    for (const d of NOT_FIRST) {
      resetClockCache();
      await tick(utc(d, "10:00", 11));
    }
    expect(bakeoffCalls()).toHaveLength(FIRST_SATURDAYS.length);
    // and the catch-up window closes after an hour
    resetClockCache();
    expect((await tick(utc("2026-12-05", "11:01", 11))).dispatched).toEqual([]);
  });

  it("missing, blank or malformed candidates: skipped (inputs-missing), never a guess, nothing claimed", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["llm-bakeoff"]));
    const t = utc("2026-11-07", "10:00", 11);
    for (const v of [
      undefined,
      "oops",
      "[]",
      '{"candidates":"  "}',
      '{"trains":"x"}',
      '{"candidates":5}',
    ]) {
      resetClockCache();
      if (v !== undefined) setState("bakeoff_inputs", v);
      const s = await tick(t);
      expect(s.dispatched, String(v)).toEqual([]);
      expect(s.skipped, String(v)).toContainEqual({ id: "llm-bakeoff", reason: "inputs-missing" });
    }
    expect(bakeoffCalls()).toHaveLength(0);
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:llm-bakeoff:%'")).toEqual(
      [],
    );
  });

  it("the inputs ride in the existing single read", async () => {
    setState("dispatch_enabled", '"1"');
    setState("slots_enabled", JSON.stringify(["llm-bakeoff"]));
    await tick(utc("2026-11-07", "09:00", 11)); // rollup
    const before = net.pipelines;
    await tick(utc("2026-11-07", "10:00", 11)); // inputs missing: read only
    expect(net.pipelines - before).toBe(1);
  });
});

describe("TST-124: the CPU and subrequest budget with the runtime list", () => {
  const facts: Facts = {
    dispatchEnabled: true,
    marketMode: "full",
    tradingDay: true,
    slotsEnabled: { kind: "list", ids: new Set(AU_SLOTS.map((s) => s.id)) },
    slotInputs: { bakeoff_inputs: { candidates: "google:m" } },
  };

  it("the decision with the list is cheap: 2000 decisions well under 1 ms each", () => {
    const local = sydneyLocal(utc("2026-11-07", "10:00", 11));
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) decideWithSkips(local, facts, new Map(), 0);
    expect((performance.now() - t0) / 2000).toBeLessThan(1);
  });

  it("the busiest tick of a first Saturday with every slot listed: Worker CPU under half the 10 ms limit", async () => {
    setState("dispatch_enabled", '"1"');
    db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();
    setState("slots_enabled", JSON.stringify(AU_SLOTS.map((s) => s.id)));
    setState("bakeoff_inputs", JSON.stringify({ candidates: "google:m" }));
    // the minute with the most due clock slots on 2026-11-07 (a first Saturday)
    let best = { n: -1, m: 0 };
    for (let m = 0; m < 1440; m++) {
      const n = candidateSlots(sydneyLocal(utc("2026-11-07", hm(m), 11))).length;
      if (n > best.n) best = { n, m };
    }
    expect(best.n).toBeGreaterThanOrEqual(2);
    const t = utc("2026-11-07", hm(best.m), 11);
    const cpu: number[] = [];
    let maxSubs = 0;
    for (let i = 0; i < 12; i++) {
      db.prepare("DELETE FROM worker_state WHERE key LIKE 'slot:%'").run();
      resetClockCache();
      let inside = 0;
      let subs = 0;
      const f = (async (a: string | URL | Request, init?: RequestInit) => {
        subs++;
        const c0 = process.cpuUsage();
        try {
          return await net.f(a, init);
        } finally {
          const c1 = process.cpuUsage(c0);
          inside += c1.user + c1.system;
        }
      }) as typeof fetch;
      vi.stubGlobal("fetch", f);
      const before = process.cpuUsage();
      await worker.scheduled({ scheduledTime: t } as ScheduledController, ENV as never);
      const used = process.cpuUsage(before);
      vi.unstubAllGlobals();
      cpu.push(Math.max(0, used.user + used.system - inside) / 1000);
      maxSubs = Math.max(maxSubs, subs);
    }
    cpu.sort((a, b) => a - b);
    expect(maxSubs).toBeLessThanOrEqual(50 - 10); // PLT-070: 50 subrequests, margin of 10
    expect(cpu[Math.floor(cpu.length / 2)]).toBeLessThan(5); // PLT-070: 10 ms; assert half
  });

  it("the daily re-enable tick and the clock stay inside the subrequest limit together", async () => {
    // a 02:40 UTC tick on a day with nothing else due: list + files + enables are bounded (10 per run)
    const t = Date.UTC(2026, 10, 7, 2, 40);
    let subs = 0;
    const f = (async (a: string | URL | Request, init?: RequestInit) => {
      subs++;
      const url = String(a);
      if (url.startsWith("https://api.github.com/") && url.includes("/actions/workflows?")) {
        return Response.json({
          workflows: Array.from({ length: 14 }, (_, i) => ({
            id: i + 1,
            path: `.github/workflows/w${i}.yml`,
            state: "disabled_inactivity",
          })),
        });
      }
      if (url.includes("/contents/")) return new Response("on:\n  schedule:\n", { status: 200 });
      if (url.endsWith("/enable")) return new Response(null, { status: 204 });
      return net.f(a, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", f);
    await worker.scheduled({ scheduledTime: t } as ScheduledController, ENV as never);
    vi.unstubAllGlobals();
    expect(subs).toBeLessThanOrEqual(50);
    expect(rows(db, "SELECT id FROM incident WHERE kind = 'workflow_reenabled'")).toHaveLength(10);
    void MIN;
  });
});
