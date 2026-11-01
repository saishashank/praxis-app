// M5 T10 (D-107): the Worker route runner. Real SQLite through the Turso fake; the app is answered by a
// local fake, so nothing touches a network. Every route slot is disabled in the shipped table; the
// tests enable copies of them.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { candidateSlots, slotKey } from "../src/clock";
import { sydneyLocal } from "../src/localtime";
import {
  decideRoutes,
  postSigned,
  purposeOf,
  routeSlotsDue,
  routeUrl,
  runRoutes,
  type RouteEnv,
} from "../src/routes";
import { AU_SLOTS, type Slot } from "../src/schedule";
import { TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
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

// Local Sydney time to a UTC instant for a fixed offset (10 = AEST, 11 = AEDT).
const at = (date: string, hm: string, offset = 11) => {
  const [h, m] = hm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, m);
};
const MON = "2026-10-19"; // AEDT Monday
const SAT = "2026-10-17"; // AEDT Saturday

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
}

let db: DatabaseSync;
let net: Net;
let app: { calls: { url: string; init: RequestInit }[]; status: number | "throw" };
let f: typeof fetch;
const deps = (now: number) => ({ fetch: f, nowMs: () => now });
const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const dispatchOn = () => setState("dispatch_enabled", '"1"');
const logs = () => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const marketFull = () => db.prepare("UPDATE market SET mode = 'full' WHERE code = 'AU'").run();

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  app = { calls: [], status: 200 };
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(APP)) {
      app.calls.push({ url, init: init ?? {} });
      if (app.status === "throw") throw new Error("boom");
      return Response.json({ ok: true }, { status: app.status });
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

describe("the route slots in the table", () => {
  it("every route slot is disabled", () => {
    const route = AU_SLOTS.filter((s) => s.runner === "route" && !M17_SLOTS.has(s.id));
    expect(route.map((s) => s.id).sort()).toEqual([
      "alert-flush",
      "evening-review",
      "evening-review-late",
      "morning",
      "pre-open",
      "pre-open-retry",
    ]);
    // M8 T8: available in the build, but listed-only (they post only when `slots_enabled` names them)
    for (const s of route) expect([s.enabled, s.requiresListing]).toEqual([true, true]);
  });

  it("evening-review: 20:00-20:45 every 5 min and 21:00-22:00 every 15 min, every day, not market-bound", () => {
    const a = AU_SLOTS.find((s) => s.id === "evening-review")!;
    const b = AU_SLOTS.find((s) => s.id === "evening-review-late")!;
    expect(a).toMatchObject({
      time: "20:00",
      until: "20:45",
      everyMin: 5,
      route: "/api/internal/evening-review",
      tradingDaysOnly: false,
      marketBound: false,
      workflow: null,
    });
    expect(b).toMatchObject({ time: "21:00", until: "22:00", everyMin: 15, enabled: true });
    const times = (date: string, offset: number) => {
      const out: string[] = [];
      for (let m = 19 * 60; m <= 23 * 60; m += 1) {
        const ms = at(date, "00:00", offset) + m * 60_000;
        const l = sydneyLocal(ms);
        expect(l.date).toBe(date);
        expect(l.minute).toBe(m);
        if (routeSlotsDue(l, on).some((s) => s.id.startsWith("evening-review"))) out.push(hm(m));
      }
      return out;
    };
    const expected = [
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
      "21:00",
      "21:15",
      "21:30",
      "21:45",
      "22:00",
    ];
    // TST-103: the same local times either side of both clock changes (AEST +10 / AEDT +11), also on
    // the weekend days around them
    for (const [date, offset] of [
      ["2026-10-03", 10],
      ["2026-10-04", 11], // the October change happens at 02:00 that Sunday
      ["2026-10-05", 11],
      ["2027-04-03", 11],
      ["2027-04-04", 10], // the April change happens at 03:00 that Sunday
      ["2027-04-05", 10],
    ] as const) {
      expect(times(date, offset)).toEqual(expected);
    }
  });

  it("the dispatch clock never fires a route slot, even when enabled", () => {
    for (const t of ["20:00", "09:54", "07:01"]) {
      const ids = candidateSlots(sydneyLocal(at(MON, t)), on).map((s) => s.id);
      for (const id of ["evening-review", "pre-open", "alert-flush"]) expect(ids).not.toContain(id);
    }
  });
});

describe("routeSlotsDue and decideRoutes (pure)", () => {
  const L = (date: string, t: string) => sydneyLocal(at(date, t));
  const facts = { dispatchEnabled: true, marketMode: "full", tradingDay: true, flushDue: false };

  it("the shipped table has slots due at 20:00, 09:54 and 07:01 but decides to post none without a list", () => {
    for (const t of ["20:00", "09:54", "07:01"]) {
      expect(routeSlotsDue(L(MON, t), AU_SLOTS).length).toBeGreaterThan(0);
      expect(decideRoutes(L(MON, t), facts, new Map(), 0, AU_SLOTS)).toEqual([]);
    }
  });
  it("evening-review is due on a Saturday too; 20:50 is between the two windows", () => {
    expect(routeSlotsDue(L(SAT, "20:05"), on).map((s) => s.id)).toEqual(["evening-review"]);
    expect(routeSlotsDue(L(SAT, "20:50"), on)).toEqual([]);
    expect(routeSlotsDue(L(SAT, "21:15"), on).map((s) => s.id)).toEqual(["evening-review-late"]);
    expect(routeSlotsDue(L(SAT, "22:15"), on)).toEqual([]);
  });
  it("alert-flush only posts once alert_flush_due has passed; trading days only", () => {
    expect(decideRoutes(L(MON, "07:01"), facts, new Map(), 0, on)).toEqual([]);
    expect(
      decideRoutes(L(MON, "07:01"), { ...facts, flushDue: true }, new Map(), 0, on).map(
        (a) => a.slot.id,
      ),
    ).toEqual(["alert-flush"]);
    expect(routeSlotsDue(L(SAT, "07:01"), on)).toEqual([]);
    expect(routeSlotsDue(L(MON, "07:02"), on)).toEqual([]); // odd minutes only
  });
  it("the kill switch gates route slots too", () => {
    expect(
      decideRoutes(L(MON, "20:00"), { ...facts, dispatchEnabled: false }, new Map(), 0, on),
    ).toEqual([]);
    expect(decideRoutes(L(MON, "20:00"), facts, new Map(), 0, on)).toHaveLength(1);
  });
  it("evening-review recurs every tick with no stored state", () => {
    const [a] = decideRoutes(L(MON, "20:05"), facts, new Map(), 0, on);
    expect(a).toMatchObject({ key: null, attempt: 1 });
  });
  it("market-bound slots wait for a market that is not off", () => {
    expect(
      decideRoutes(L(MON, "09:54"), { ...facts, marketMode: "off" }, new Map(), 0, on),
    ).toEqual([]);
    expect(decideRoutes(L(MON, "09:54"), { ...facts, marketMode: null }, new Map(), 0, on)).toEqual(
      [],
    );
  });
  it("pre-open-retry runs only if pre-open is not dispatched; each slot tries once", () => {
    const st = (s: string, n: number) => {
      const raw = JSON.stringify({ s, n, at: "2026-10-18T22:54:00.000Z" });
      return { raw, state: JSON.parse(raw) };
    };
    const k1 = slotKey("pre-open", MON);
    expect(decideRoutes(L(MON, "09:58"), facts, new Map(), 0, on).map((a) => a.slot.id)).toEqual([
      "pre-open-retry",
    ]);
    expect(
      decideRoutes(L(MON, "09:58"), facts, new Map([[k1, st("dispatched", 1)]]), 0, on),
    ).toEqual([]);
    expect(
      decideRoutes(L(MON, "09:58"), facts, new Map([[k1, st("failed", 1)]]), 0, on).map(
        (a) => a.slot.id,
      ),
    ).toEqual(["pre-open-retry"]);
    // maxAttempts 1: a failed 09:54 is not repeated at 09:55
    expect(decideRoutes(L(MON, "09:55"), facts, new Map([[k1, st("failed", 1)]]), 0, on)).toEqual(
      [],
    );
  });
});

describe("runRoutes", () => {
  it("posts nothing with the shipped table and no list: one read (for the list), no post, no log", async () => {
    dispatchOn();
    net.pipelines = 0;
    const s = await runRoutes(ENV, at(MON, "20:00"), deps(at(MON, "20:00")));
    expect(s).toEqual({ requests: 1, posted: [], failed: [] });
    expect(net.pipelines).toBe(1);
    expect(app.calls).toHaveLength(0);
    expect(logs()).toEqual([]);
  });

  it("the scheduled handler runs it without throwing or posting while disabled", async () => {
    dispatchOn();
    vi.stubGlobal("fetch", net.f);
    try {
      await worker.scheduled(
        { scheduledTime: at(MON, "20:00") } as ScheduledController,
        {
          ...ENV,
        } as never,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(app.calls).toHaveLength(0);
  });

  it("idle minute with slots enabled: no database request", async () => {
    dispatchOn();
    net.pipelines = 0;
    await runRoutes(ENV, at(MON, "14:00"), deps(at(MON, "14:00")), on);
    expect(net.pipelines).toBe(0);
    expect(app.calls).toHaveLength(0);
  });

  it("an enabled evening-review tick posts a correctly signed, bound request (D-029)", async () => {
    dispatchOn();
    const t = at(MON, "20:00");
    const s = await runRoutes(ENV, t, deps(t), on);
    expect(s.posted).toEqual(["evening-review"]);
    expect(app.calls).toHaveLength(1);
    const { url, init } = app.calls[0]!;
    expect(url).toBe(`${APP}/api/internal/evening-review`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = init.headers as Record<string, string>;
    expect(h["X-Praxis-Timestamp"]).toBe(String(Math.floor(t / 1000)));
    expect(h["X-Praxis-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual({
      purpose: "evening-review",
      env: "production",
      d: MON,
      slot: "evening-review",
    });
    expect(h["X-Praxis-Signature"]).toBe(
      await hmacHex(SECRET, `${h["X-Praxis-Timestamp"]}.${h["X-Praxis-Nonce"]}.${body}`),
    );
    expect(JSON.stringify(logs())).not.toContain(SECRET);
    // a recurring slot keeps no slot state
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
  });

  it("each tick uses a fresh nonce", async () => {
    dispatchOn();
    for (const t of ["20:00", "20:05"]) await runRoutes(ENV, at(MON, t), deps(at(MON, t)), on);
    const n = app.calls.map((c) => (c.init.headers as Record<string, string>)["X-Praxis-Nonce"]);
    expect(new Set(n).size).toBe(2);
  });

  it("with dispatch off (the default) nothing is posted", async () => {
    await runRoutes(ENV, at(MON, "20:00"), deps(at(MON, "20:00")), on);
    expect(app.calls).toHaveLength(0);
  });

  it("missing app url, secret or an http url: nothing posted, no database request", async () => {
    dispatchOn();
    net.pipelines = 0;
    const t = at(MON, "20:00");
    for (const bad of [
      { APP_BASE_URL: undefined },
      { WORKER_HMAC_SECRET: undefined },
      { APP_BASE_URL: "http://praxis-app.example.test" },
      { PRAXIS_ENV: "development" },
    ]) {
      await runRoutes({ ...ENV, ...bad }, t, deps(t), on);
    }
    expect(app.calls).toHaveLength(0);
    expect(net.pipelines).toBe(0);
  });

  it("a failing recurring slot logs, is retried by the next tick, keeps no state and records ONE failure per slot and day (V2-B1)", async () => {
    dispatchOn();
    app.status = 503;
    const s = await runRoutes(ENV, at(MON, "20:00"), deps(at(MON, "20:00")), on);
    expect(s.failed).toEqual(["evening-review"]);
    expect(logs()).toContain("routes: failed evening-review attempt 1");
    app.status = 200;
    const s2 = await runRoutes(ENV, at(MON, "20:05"), deps(at(MON, "20:05")), on);
    expect(s2.posted).toEqual(["evening-review"]);
    const rec = rows(
      db,
      "SELECT concurrency_key, status, error_summary FROM run_record WHERE job = 'worker-route'",
    );
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      concurrency_key: `route-failed:evening-review:${MON}:recurring`,
      status: "failed",
    });
    expect(String(rec[0]!.error_summary)).toContain("evening-review");
    // a second failing tick the same day adds no second row
    app.status = 503;
    await runRoutes(ENV, at(MON, "20:10"), deps(at(MON, "20:10")), on);
    expect(rows(db, "SELECT 1 FROM run_record WHERE job = 'worker-route'")).toHaveLength(1);
  });

  it("a network error is contained", async () => {
    dispatchOn();
    app.status = "throw";
    const s = await runRoutes(ENV, at(MON, "20:00"), deps(at(MON, "20:00")), on);
    expect(s.failed).toEqual(["evening-review"]);
  });

  it("a single-shot slot claims once, records dispatched, and is not posted twice", async () => {
    dispatchOn();
    marketFull();
    const a = await runRoutes(ENV, at(MON, "09:54"), deps(at(MON, "09:54")), on);
    expect(a.posted).toEqual(["pre-open"]);
    expect(JSON.parse(String(app.calls[0]!.init.body))).toMatchObject({
      purpose: "preopen",
      attempt: 1,
      slot: "pre-open",
    });
    const st = rows(
      db,
      "SELECT value_json FROM worker_state WHERE key = ?",
      slotKey("pre-open", MON),
    ) as { value_json: string }[];
    expect(JSON.parse(st[0]!.value_json)).toMatchObject({ s: "dispatched", n: 1 });
    await runRoutes(ENV, at(MON, "09:55"), deps(at(MON, "09:55")), on);
    expect(app.calls).toHaveLength(1);
    // 09:58: the first attempt worked, so no retry
    await runRoutes(ENV, at(MON, "09:58"), deps(at(MON, "09:58")), on);
    expect(app.calls).toHaveLength(1);
  });

  it("a failed 09:54 leaves a failed run record, and 09:58 posts attempt 2", async () => {
    dispatchOn();
    marketFull();
    app.status = 503;
    await runRoutes(ENV, at(MON, "09:54"), deps(at(MON, "09:54")), on);
    const rec = rows(
      db,
      "SELECT status, error_summary, concurrency_key FROM run_record WHERE job = 'worker-route'",
    ) as { status: string; error_summary: string; concurrency_key: string }[];
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      status: "failed",
      concurrency_key: `route-failed:pre-open:${MON}:1`,
    });
    expect(rec[0]!.error_summary).toBe("route pre-open HTTP 503");
    await runRoutes(ENV, at(MON, "09:55"), deps(at(MON, "09:55")), on);
    expect(app.calls).toHaveLength(1); // maxAttempts 1
    app.status = 200;
    await runRoutes(ENV, at(MON, "09:58"), deps(at(MON, "09:58")), on);
    expect(app.calls).toHaveLength(2);
    expect(JSON.parse(String(app.calls[1]!.init.body))).toMatchObject({
      attempt: 2,
      slot: "pre-open-retry",
    });
  });

  it("alert-flush posts only when alert_flush_due has passed", async () => {
    dispatchOn();
    marketFull();
    await runRoutes(ENV, at(MON, "07:01"), deps(at(MON, "07:01")), on);
    expect(app.calls).toHaveLength(0);
    setState("alert_flush_due", JSON.stringify(new Date(at(MON, "07:01") + 60_000).toISOString()));
    await runRoutes(ENV, at(MON, "07:01"), deps(at(MON, "07:01")), on);
    expect(app.calls).toHaveLength(0); // not yet
    await runRoutes(ENV, at(MON, "07:03"), deps(at(MON, "07:03")), on);
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]!.url).toBe(`${APP}/api/internal/alert-flush`);
  });

  it("market-bound slots do not post on a holiday; evening-review does", async () => {
    dispatchOn();
    marketFull();
    const hol = "2026-12-25";
    await runRoutes(ENV, at(hol, "09:54"), deps(at(hol, "09:54")), on);
    expect(app.calls).toHaveLength(0);
    await runRoutes(ENV, at(hol, "20:00"), deps(at(hol, "20:00")), on);
    expect(app.calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("routeUrl accepts https origins only and keeps the path", () => {
    expect(routeUrl("https://a.example.test/", "/api/x")).toBe("https://a.example.test/api/x");
    expect(routeUrl("http://a.example.test", "/api/x")).toBeNull();
    expect(routeUrl("", "/api/x")).toBeNull();
    expect(routeUrl("not a url", "/api/x")).toBeNull();
    expect(purposeOf("/api/internal/alert-flush")).toBe("alert-flush");
  });
  it("postSigned without configuration answers not-configured and calls nothing", async () => {
    const slot = AU_SLOTS.find((s) => s.id === "evening-review")!;
    const r = await postSigned({ ...ENV, WORKER_HMAC_SECRET: "" }, slot, MON, deps(0));
    expect(r).toEqual({ ok: false, detail: "not-configured" });
    expect(app.calls).toHaveLength(0);
  });
});
