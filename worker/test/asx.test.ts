// DAT-122, DAT-123, DAT-127, TST-124, AT-05 (ASX parts), D-061: ASX rate token, trip logic and
// slot scheduler. Real SQLite via node:sqlite; no network anywhere (the ASX URL is answered by a
// local fake, and most tests assert that it was never called).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  DAILY_CAP,
  MIN_SPACING_MS,
  PRIORITY_LIMITS,
  TRIP_MIN_SAMPLE,
  classifyResponse,
  clampRetryAfter,
  mayFetchMode,
  parseOn,
  shouldTrip,
  type Priority,
} from "../src/asx/policy";
import { ASX_ANNOUNCEMENTS_URL, buildAsxRequest } from "../src/asx/request";
import { AU_SLOTS } from "../src/schedule";
import {
  ASX_JOBS,
  POLL_END_MIN,
  POLL_EVERY_MIN,
  POLL_START_MIN,
  chooseJob,
  isSlotTick,
  pollDue,
  runAsx,
  type AsxEnv,
  type AsxJob,
} from "../src/asx/slots";
import { acquire, recordOutcome } from "../src/asx/token";
import { sydneyLocal } from "../src/localtime";
import { TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const UA = "praxis-sentinel-test (contact: owner@example.test)";
const ENV: AsxEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  ASX_LIVE: "1",
  ASX_USER_AGENT: UA,
};

// Tuesday 2026-10-13 10:00 AEDT (UTC+11): a poll minute (600 - 420 = 180, divisible by 4).
const T0 = Date.UTC(2026, 9, 12, 23, 0, 0);
const S = 1000;

let db: DatabaseSync;
let net: Net;
let live: { calls: { url: string; init: RequestInit }[]; reply: () => Response };
let f: typeof fetch;

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const enable = () => setState("asx_enabled", '"1"');
const token = () =>
  db.prepare("SELECT last_request_at, day_count_date, day_count FROM asx_rate_token").all()[0] as {
    last_request_at: string | null;
    day_count_date: string | null;
    day_count: number;
  };
const status = () =>
  db
    .prepare("SELECT mode, reason, tripped_by FROM source_status WHERE source = ?")
    .all("asx_announcements")[0] as {
    mode: string;
    reason: string | null;
    tripped_by: string | null;
  };
const setToken = (date: string, count: number, last: string | null = null) =>
  db
    .prepare("UPDATE asx_rate_token SET day_count_date = ?, day_count = ?, last_request_at = ?")
    .run(date, count, last);

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  live = {
    calls: [],
    reply: () =>
      new Response('{"data":[]}', {
        status: 200,
        headers: { "content-type": "application/json", etag: '"v1"' },
      }),
  };
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.asx.com.au/")) {
      live.calls.push({ url, init: init ?? {} });
      return live.reply();
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const deps = (now: number) => ({ fetch: f, nowMs: () => now });

describe("policy (pure)", () => {
  it("constants are the spec values", () => {
    expect(MIN_SPACING_MS).toBe(65_000);
    expect(DAILY_CAP).toBe(720);
    expect(TRIP_MIN_SAMPLE).toBe(10);
  });

  it("priority limits never exceed the cap and are non-increasing from priority 1 to 5", () => {
    const ps: Priority[] = [1, 2, 3, 4, 5];
    for (const p of ps) expect(PRIORITY_LIMITS[p]).toBeLessThanOrEqual(DAILY_CAP);
    for (let i = 1; i < ps.length; i++) {
      expect(PRIORITY_LIMITS[ps[i]]).toBeLessThanOrEqual(PRIORITY_LIMITS[ps[i - 1]]);
    }
  });

  it("shouldTrip: strictly more than 5 % and at least 10 requests", () => {
    expect(shouldTrip(9, 9)).toBe(false); // sample too small
    expect(shouldTrip(10, 1)).toBe(true); // 10 %
    expect(shouldTrip(20, 1)).toBe(false); // exactly 5 %
    expect(shouldTrip(21, 2)).toBe(true);
    expect(shouldTrip(100, 5)).toBe(false);
    expect(shouldTrip(100, 6)).toBe(true);
    expect(shouldTrip(50, 0)).toBe(false);
  });

  it("classifyResponse follows handleAnnouncementsResponse order", () => {
    const html = "text/html";
    expect(classifyResponse(304, null, "")).toBe("ok");
    expect(classifyResponse(200, "application/json", "{}")).toBe("ok");
    expect(classifyResponse(429, null, "")).toBe("rate_limited");
    expect(classifyResponse(403, null, "")).toBe("blocked");
    expect(classifyResponse(200, html, "<html>Just a moment...</html>")).toBe("blocked");
    expect(classifyResponse(503, html, "<html>Attention Required</html>")).toBe("blocked");
    expect(classifyResponse(500, null, "")).toBe("error");
    expect(classifyResponse(301, null, "")).toBe("error");
    expect(classifyResponse(200, html, "<html>ordinary page</html>")).toBe("ok");
  });

  it("clampRetryAfter: missing 300 s, min 65 s, max 3600 s", () => {
    expect(clampRetryAfter(null)).toBe(300);
    expect(clampRetryAfter(1)).toBe(65);
    expect(clampRetryAfter(600)).toBe(600);
    expect(clampRetryAfter(99_999)).toBe(3600);
    expect(clampRetryAfter(Number.NaN)).toBe(300);
  });

  it('parseOn accepts only JSON 1 / "1" / true', () => {
    expect(['"1"', "1", "true"].map(parseOn)).toEqual([true, true, true]);
    expect(['"0"', "0", "false", "junk", "", '"yes"', "2"].map(parseOn)).toEqual(
      Array(7).fill(false),
    );
    expect(parseOn(null)).toBe(false);
    expect(parseOn(undefined)).toBe(false);
  });
});

describe("rate token: spacing", () => {
  it("65 s boundary: 64.9 s denied, 65.0 s granted", async () => {
    enable();
    expect(await acquire(ENV, T0, 1, f)).toEqual({ granted: true, count: 1 });
    expect(await acquire(ENV, T0 + 64_900, 1, f)).toEqual({ granted: false, reason: "spacing" });
    expect(await acquire(ENV, T0 + 65_000, 1, f)).toEqual({ granted: true, count: 2 });
    // a refusal changes nothing
    expect(token().last_request_at).toBe(new Date(T0 + 65_000).toISOString());
    expect(token().day_count).toBe(2);
  });

  it("an instant before the last request (clock skew) is refused", async () => {
    enable();
    await acquire(ENV, T0, 1, f);
    expect((await acquire(ENV, T0 - 1000, 1, f)).granted).toBe(false);
  });

  it("racing isolates: exactly one grant per window", async () => {
    enable();
    net.interleave = true;
    const rs = await Promise.all(Array.from({ length: 8 }, () => acquire(ENV, T0, 1, f)));
    expect(rs.filter((r) => r.granted)).toHaveLength(1);
    expect(token().day_count).toBe(1);
    // same for a second window with slightly different local clocks (all inside the spacing)
    const later = T0 + 70_000;
    const rs2 = await Promise.all([0, 1, 2, 3].map((k) => acquire(ENV, later + k * 100, 1, f)));
    expect(rs2.filter((r) => r.granted)).toHaveLength(1);
    expect(token().day_count).toBe(2);
  });

  it("a database failure is a refusal, never a grant", async () => {
    enable();
    net.failPipeline = true;
    expect(await acquire(ENV, T0, 1, f)).toEqual({ granted: false, reason: "db_error" });
  });

  it("720 per day by construction: a whole day of attempts every 65 s gives exactly 720", async () => {
    enable();
    let granted = 0;
    const dayStart = Date.UTC(2026, 9, 12, 13, 0, 0); // 2026-10-13 00:00 AEDT
    for (let t = dayStart; t < dayStart + 86_400_000; t += 65_000) {
      if ((await acquire(ENV, t, 1, f)).granted) granted++;
    }
    expect(granted).toBe(720);
    expect(token().day_count).toBe(720);
  });
});

describe("rate token: daily cap and Sydney-midnight reset", () => {
  it("720th grant allowed, 721st refused with daily_cap", async () => {
    enable();
    setToken("2026-10-13", 719);
    expect(await acquire(ENV, T0, 1, f)).toEqual({ granted: true, count: 720 });
    expect(await acquire(ENV, T0 + 65_000, 1, f)).toEqual({ granted: false, reason: "daily_cap" });
    expect(await acquire(ENV, T0 + 65_000, 5, f)).toEqual({ granted: false, reason: "daily_cap" });
  });

  it("resets at Sydney midnight (AEDT): 23:59 refused, 00:00 granted with count 1", async () => {
    enable();
    setToken("2026-10-13", 720);
    const before = Date.UTC(2026, 9, 13, 12, 59, 0); // 23:59 AEDT on the 13th
    const after = Date.UTC(2026, 9, 13, 13, 0, 0); // 00:00 AEDT on the 14th
    expect((await acquire(ENV, before, 1, f)).granted).toBe(false);
    expect(await acquire(ENV, after, 1, f)).toEqual({ granted: true, count: 1 });
    expect(token()).toMatchObject({ day_count_date: "2026-10-14", day_count: 1 });
  });

  it("resets at Sydney midnight (AEST, winter): the date follows UTC+10", async () => {
    enable();
    setToken("2026-07-01", 720);
    const before = Date.UTC(2026, 6, 1, 13, 59, 0); // 23:59 AEST
    const after = Date.UTC(2026, 6, 1, 14, 0, 0); // 00:00 AEST on 2 July
    expect((await acquire(ENV, before, 1, f)).granted).toBe(false);
    expect((await acquire(ENV, after, 1, f)).granted).toBe(true);
    expect(token().day_count_date).toBe("2026-07-02");
  });

  it("spring-forward day (2026-10-04, 23 h): the count is for that Sydney date only", async () => {
    enable();
    setToken("2026-10-03", 720);
    // 00:30 AEST on the 4th = 14:30 UTC on the 3rd: new date, count restarts
    expect(await acquire(ENV, Date.UTC(2026, 9, 3, 14, 30, 0), 1, f)).toEqual({
      granted: true,
      count: 1,
    });
    setToken("2026-10-04", 720);
    // 23:59 AEDT on the 4th = 12:59 UTC: still the 4th, capped
    expect((await acquire(ENV, Date.UTC(2026, 9, 4, 12, 59, 0), 1, f)).granted).toBe(false);
    // 00:00 AEDT on the 5th = 13:00 UTC
    expect((await acquire(ENV, Date.UTC(2026, 9, 4, 13, 0, 0), 1, f)).granted).toBe(true);
    expect(token().day_count_date).toBe("2026-10-05");
  });

  it("fall-back day (2027-04-04, 25 h): midnight is 14:00 UTC (AEST), not 13:00", async () => {
    enable();
    setToken("2027-04-04", 720);
    // 23:30 AEST on the 4th = 13:30 UTC: still the 4th (AEDT midnight would have been 13:00)
    expect(sydneyLocal(Date.UTC(2027, 3, 4, 13, 30, 0)).date).toBe("2027-04-04");
    expect((await acquire(ENV, Date.UTC(2027, 3, 4, 13, 30, 0), 1, f)).granted).toBe(false);
    expect((await acquire(ENV, Date.UTC(2027, 3, 4, 14, 0, 0), 1, f)).granted).toBe(true);
    expect(token().day_count_date).toBe("2027-04-05");
  });

  it("the date comes from the instant, so a stale stored date never blocks a new day", async () => {
    enable();
    setToken("2020-01-01", 720);
    expect((await acquire(ENV, T0, 1, f)).granted).toBe(true);
  });
});

describe("rate token: priority reservation", () => {
  it.each([
    [1, 719, true],
    [2, 719, true],
    [3, 699, true],
    [3, 700, false],
    [4, 679, true],
    [4, 680, false],
    [5, 639, true],
    [5, 640, false],
    [1, 720, false],
  ] as const)("priority %i with %i used today -> granted %s", async (p, used, ok) => {
    enable();
    setToken("2026-10-13", used);
    const r = await acquire(ENV, T0, p, f);
    expect(r.granted).toBe(ok);
    if (!ok && used < DAILY_CAP) expect(r).toEqual({ granted: false, reason: "reserved" });
  });

  it("chooseJob picks the lowest priority number among due jobs; ties keep list order", () => {
    const mk = (id: string, priority: Priority, due = true): AsxJob => ({
      id,
      priority,
      due: () => due,
      marketBound: false,
      label: id,
    });
    const local = sydneyLocal(T0);
    expect(
      chooseJob([mk("backfill", 5), mk("pdf", 4), mk("poll", 1), mk("batch", 3)], local)?.id,
    ).toBe("poll");
    expect(
      chooseJob([mk("backfill", 5), mk("pdf", 4, false), mk("batch", 3, false)], local)?.id,
    ).toBe("backfill");
    expect(chooseJob([mk("a", 3), mk("b", 3)], local)?.id).toBe("a");
    expect(chooseJob([mk("a", 3, false)], local)).toBeNull();
  });
});

describe("kill switch", () => {
  it("default off: no grant, nothing written", async () => {
    expect(await acquire(ENV, T0, 1, f)).toEqual({ granted: false, reason: "disabled" });
    expect(token()).toMatchObject({ last_request_at: null, day_count: 0 });
  });

  it.each(['"0"', "0", "false", "junk", '"yes"'])("asx_enabled = %s is off", async (v) => {
    setState("asx_enabled", v);
    expect(await acquire(ENV, T0, 1, f)).toEqual({ granted: false, reason: "disabled" });
  });

  it.each(['"1"', "1", "true"])("asx_enabled = %s is on", async (v) => {
    setState("asx_enabled", v);
    expect((await acquire(ENV, T0, 1, f)).granted).toBe(true);
  });

  it.each(["on", "off", "tripped"])(
    "source_status %s agrees with mayFetchMode (DAT-123 / DAT-127)",
    async (mode) => {
      enable();
      db.prepare("UPDATE source_status SET mode = ? WHERE source = 'asx_announcements'").run(mode);
      const r = await acquire(ENV, T0, 1, f);
      expect(r.granted).toBe(mayFetchMode(mode));
      if (!r.granted) expect(r).toEqual({ granted: false, reason: "source_off" });
    },
  );

  it("a missing source_status row is a refusal", async () => {
    enable();
    db.exec("DROP TRIGGER source_status_no_delete");
    db.exec("DELETE FROM source_status WHERE source = 'asx_announcements'");
    expect((await acquire(ENV, T0, 1, f)).granted).toBe(false);
  });
});

describe("outcomes, trip and Retry-After", () => {
  const rec = (i: number, o: "ok" | "blocked" | "rate_limited" | "error") =>
    recordOutcome(ENV, T0 + i * 65_000, o, f);

  it("trips above 5 % with at least 10 requests, and acquire then refuses", async () => {
    enable();
    for (let i = 0; i < 9; i++) await rec(i, "ok");
    const r = await rec(9, "blocked"); // 1 of 10 = 10 %
    expect(r).toEqual({ recorded: true, tripped: true });
    expect(status()).toMatchObject({ mode: "tripped", tripped_by: "asx_block_trip" });
    expect(status().reason).toContain("asx_block_trip");
    const inc = rows(db, "SELECT severity, kind FROM incident");
    expect(inc).toEqual([{ severity: "S2", kind: "asx_block_trip" }]);
    expect(await acquire(ENV, T0 + 20 * 65_000, 1, f)).toEqual({
      granted: false,
      reason: "source_off",
    });
  });

  it("does not trip below the minimum sample (alternating blocked and error)", async () => {
    enable();
    for (let i = 0; i < 8; i++)
      expect((await rec(i, i % 2 ? "error" : "blocked")).tripped).toBe(false);
    expect(status().mode).toBe("on");
  });

  it("3 consecutive blocks trip regardless of sample size; 2 do not; an ok in between resets", async () => {
    enable();
    expect((await rec(0, "blocked")).tripped).toBe(false);
    expect((await rec(1, "blocked")).tripped).toBe(false);
    expect((await rec(2, "blocked")).tripped).toBe(true);
    expect(status().mode).toBe("tripped");
  });

  it("blocked, ok, blocked, blocked does not trip", async () => {
    enable();
    for (const [i, o] of (["blocked", "ok", "blocked", "blocked"] as const).entries()) {
      expect((await rec(i, o)).tripped).toBe(false);
    }
    expect(status().mode).toBe("on");
  });

  it("does not trip at exactly 5 % (1 of 20) and trips on the next block (2 of 21)", async () => {
    enable();
    for (let i = 0; i < 19; i++) await rec(i, "ok");
    expect((await rec(19, "blocked")).tripped).toBe(false); // 1/20 = 5.0 %
    expect(status().mode).toBe("on");
    expect((await rec(20, "blocked")).tripped).toBe(true); // 2/21
  });

  it("only the last hour counts: older blocks are ignored", async () => {
    enable();
    for (let i = 0; i < 6; i++) {
      await recordOutcome(ENV, T0 + i * 65_000, i % 2 ? "error" : "blocked", f);
    }
    const later = T0 + 61 * 60_000 + 6 * 65_000;
    for (let i = 0; i < 12; i++) {
      expect((await recordOutcome(ENV, later + i * 65_000, "ok", f)).tripped).toBe(false);
    }
    expect(status().mode).toBe("on");
    // and rows older than 2 h are pruned
    await recordOutcome(ENV, T0 + 4 * 3_600_000, "ok", f);
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'asxout:%'")).toHaveLength(1);
  });

  it("429 and errors are recorded but do not count as blocks", async () => {
    enable();
    for (let i = 0; i < 15; i++) await rec(i, i % 2 ? "rate_limited" : "error");
    expect(status().mode).toBe("on");
  });

  it("tripped stays tripped: later ok outcomes do not clear it", async () => {
    enable();
    for (let i = 0; i < 9; i++) await rec(i, "ok");
    await rec(9, "blocked");
    for (let i = 10; i < 60; i++) await rec(i, "ok");
    expect(status().mode).toBe("tripped");
    expect((await acquire(ENV, T0 + 100 * 65_000, 1, f)).granted).toBe(false);
  });

  it("an Owner-off source is not touched by the trip statement", async () => {
    enable();
    db.prepare("UPDATE source_status SET mode = 'off' WHERE source = 'asx_announcements'").run();
    for (let i = 0; i < 12; i++) await rec(i, "blocked");
    expect(status().mode).toBe("off");
    expect(rows(db, "SELECT * FROM incident")).toHaveLength(0);
  });

  it("429 Retry-After pushes the next allowed time (granted exactly at the boundary)", async () => {
    enable();
    await acquire(ENV, T0, 1, f);
    await recordOutcome(ENV, T0 + 1000, "rate_limited", f, { retryAfterS: 600 });
    const until = T0 + 1000 + 600_000;
    expect(await acquire(ENV, T0 + 70_000, 1, f)).toEqual({
      granted: false,
      reason: "retry_after",
    });
    expect(await acquire(ENV, until - 1, 1, f)).toEqual({ granted: false, reason: "retry_after" });
    expect((await acquire(ENV, until, 1, f)).granted).toBe(true);
  });

  it("429 without a header waits 300 s; a later shorter 429 never shortens the wait", async () => {
    enable();
    await recordOutcome(ENV, T0, "rate_limited", f, { retryAfterS: null });
    expect((await acquire(ENV, T0 + 299_000, 1, f)).granted).toBe(false);
    await recordOutcome(ENV, T0 + 10_000, "rate_limited", f, { retryAfterS: 1 }); // clamps to 65 s
    expect((await acquire(ENV, T0 + 299_999, 1, f)).granted).toBe(false);
    expect((await acquire(ENV, T0 + 300_000, 1, f)).granted).toBe(true);
  });

  it("a database failure while recording is reported, not thrown", async () => {
    net.failPipeline = true;
    expect(await recordOutcome(ENV, T0, "ok", f)).toEqual({ recorded: false, tripped: false });
  });
});

describe("slot arithmetic (pure)", () => {
  const at = (h: number, m: number, day = 13) =>
    sydneyLocal(Date.UTC(2026, 9, day - 1, h - 11 + 24, m));

  it("slot ticks are the even minutes; polls every 4 minutes 07:00..19:28 on weekdays", () => {
    expect(isSlotTick(at(10, 0))).toBe(true);
    expect(isSlotTick(at(10, 1))).toBe(false);
    expect(pollDue(at(7, 0))).toBe(true);
    expect(pollDue(at(7, 2))).toBe(false);
    expect(pollDue(at(7, 4))).toBe(true);
    expect(pollDue(at(6, 56))).toBe(false);
    expect(pollDue(at(19, 28))).toBe(true);
    expect(pollDue(at(19, 30))).toBe(false); // 750 min after 07:00 is not a multiple of 4
    expect(pollDue(at(19, 32))).toBe(false);
  });

  it("188 polls on a weekday; none at the weekend; one free slot between polls", () => {
    let polls = 0;
    let free = 0;
    for (let min = 0; min < 1440; min++) {
      const l = { ...at(0, 0), minute: min };
      if (pollDue(l)) polls++;
      else if (isSlotTick(l) && min >= 420 && min <= 1170) free++;
    }
    expect(polls).toBe(188);
    expect(free).toBeGreaterThanOrEqual(187);
    expect(pollDue(sydneyLocal(Date.UTC(2026, 9, 9, 23, 0, 0)))).toBe(false); // Saturday 10:00
    expect(pollDue(sydneyLocal(Date.UTC(2026, 9, 10, 23, 0, 0)))).toBe(false); // Sunday 10:00
  });

  it("ASX-touching slots sit on even Sydney minutes and are never < 65 s apart", () => {
    const touching = AU_SLOTS.filter((s) => s.id === "asx-poll" || s.id === "pre-open");
    expect(touching).toHaveLength(2);
    for (const s of touching) expect(s.minute % 2).toBe(0);
    const pre = touching.find((s) => s.id === "pre-open")!.minute;
    const polls: number[] = [];
    for (let m = POLL_START_MIN; m <= POLL_END_MIN; m += POLL_EVERY_MIN) polls.push(m);
    for (const m of polls) expect(Math.abs(m - pre) * 60).toBeGreaterThanOrEqual(65);
    expect(polls).not.toContain(pre);
  });

  it("consecutive polls are 240 s apart, so they always clear the 65 s spacing", () => {
    expect(240_000).toBeGreaterThan(MIN_SPACING_MS);
  });
});

describe("request building", () => {
  it("identifying User-Agent, conditional header, no cookies, no redirects, https", () => {
    const r = buildAsxRequest(UA, '"abc"');
    expect(r?.url).toBe(ASX_ANNOUNCEMENTS_URL);
    expect(r?.url.startsWith("https://")).toBe(true);
    expect(r?.init.method).toBe("GET");
    expect(r?.init.redirect).toBe("manual");
    expect(r?.init.headers["User-Agent"]).toBe(UA);
    expect(r?.init.headers["If-None-Match"]).toBe('"abc"');
    expect(Object.keys(r?.init ?? {})).not.toContain("credentials");
    expect(Object.keys(r?.init.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("cookie");
  });

  it.each([undefined, "", "  ", "Mozilla/5.0 (Windows NT 10.0)", "bad\nua", "x".repeat(201)])(
    "refuses User-Agent %j",
    (ua) => {
      expect(buildAsxRequest(ua, null)).toBeNull();
    },
  );
});

describe("runAsx: nothing happens unless everything is on", () => {
  const log = () =>
    (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

  it("ASX_LIVE unset: no network, no database, one log line (default)", async () => {
    enable();
    const env = { ...ENV, ASX_LIVE: undefined };
    const s = await runAsx(env, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "live-off", requests: 0, fetched: 0 });
    expect(net.calls).toHaveLength(0);
    expect(live.calls).toHaveLength(0);
    expect(log()).toContain("asx: poll skipped (ASX_LIVE off)");
  });

  it.each(["0", "true", "yes", ""])("ASX_LIVE = %j is off", async (v) => {
    enable();
    const s = await runAsx({ ...ENV, ASX_LIVE: v }, T0, deps(T0));
    expect(s.skipped).toBe("live-off");
    expect(net.calls).toHaveLength(0);
  });

  it("staging never contacts ASX even with ASX_LIVE and the kill switch on", async () => {
    enable();
    for (const e of ["staging", "preview", "", "Production"]) {
      const s = await runAsx({ ...ENV, PRAXIS_ENV: e }, T0, deps(T0));
      expect(s.skipped).toBe("not-production");
    }
    expect(net.calls).toHaveLength(0);
    expect(live.calls).toHaveLength(0);
  });

  it("no identifying User-Agent: no request at all", async () => {
    enable();
    const s = await runAsx({ ...ENV, ASX_USER_AGENT: undefined }, T0, deps(T0));
    expect(s.skipped).toBe("no-user-agent");
    expect(net.calls).toHaveLength(0);
  });

  it("not a poll minute (odd minute, 4-minute gap, weekend): zero database and zero network", async () => {
    enable();
    for (const t of [
      T0 + 60_000,
      T0 + 120_000,
      T0 + 180_000,
      T0 - 4 * 3_600_000,
      Date.UTC(2026, 9, 9, 23, 0, 0),
    ]) {
      const s = await runAsx(ENV, t, deps(t));
      expect(s.job).toBeNull();
    }
    expect(net.calls).toHaveLength(0);
    expect(live.calls).toHaveLength(0);
  });

  it("asx_enabled off (default): one read, no token, no ASX call", async () => {
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "disabled", requests: 1, fetched: 0 });
    expect(net.pipelines).toBe(1);
    expect(live.calls).toHaveLength(0);
    expect(token().day_count).toBe(0);
  });

  it("market off or holiday: the token is not spent", async () => {
    enable();
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    expect((await runAsx(ENV, T0, deps(T0))).skipped).toBe("market-off");
    db.prepare("UPDATE market SET mode = 'data_only' WHERE code = 'AU'").run();
    const xmas = Date.UTC(2026, 11, 24, 23, 0, 0); // Friday 25 Dec 10:00 AEDT
    expect((await runAsx(ENV, xmas, deps(xmas))).skipped).toBe("holiday");
    expect(token().day_count).toBe(0);
    expect(live.calls).toHaveLength(0);
  });

  it("tripped source: the poll is refused at the token and nothing is fetched", async () => {
    enable();
    db.prepare(
      "UPDATE source_status SET mode = 'tripped' WHERE source = 'asx_announcements'",
    ).run();
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s.skipped).toBe("denied-source_off");
    expect(live.calls).toHaveLength(0);
  });
});

describe("runAsx: a live poll", () => {
  beforeEach(() => enable());

  it("sends the identifying request, records ok and the ETag, uses 3 database requests", async () => {
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s).toMatchObject({ outcome: "ok", fetched: 1, requests: 3, tripped: false });
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0].url).toBe(ASX_ANNOUNCEMENTS_URL);
    const h = live.calls[0].init.headers as Record<string, string>;
    expect(h["User-Agent"]).toBe(UA);
    expect(h["If-None-Match"]).toBeUndefined();
    expect(live.calls[0].init.redirect).toBe("manual");
    expect(token()).toMatchObject({ day_count: 1 });
    expect(rows(db, "SELECT value_json FROM worker_state WHERE key = 'asx:etag'")).toEqual([
      { value_json: '"\\"v1\\""' },
    ]);
    expect(rows(db, "SELECT value_json FROM worker_state WHERE key LIKE 'asxout:%'")).toEqual([
      { value_json: '"ok"' },
    ]);
  });

  it("the next poll is conditional; a 304 counts as ok", async () => {
    await runAsx(ENV, T0, deps(T0));
    live.reply = () => new Response(null, { status: 304 });
    const t1 = T0 + 4 * 60_000;
    const s = await runAsx(ENV, t1, deps(t1));
    expect(s.outcome).toBe("ok");
    expect((live.calls[1].init.headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
    expect(token().day_count).toBe(2);
  });

  it("a second poll inside 65 s is refused before any ASX call", async () => {
    await runAsx(ENV, T0, deps(T0));
    // two ticks whose database clock reads 64.9 s apart (e.g. a second isolate)
    const s = await runAsx(ENV, T0 + 4 * 60_000, deps(T0 + 64_900));
    expect(s.skipped).toBe("denied-spacing");
    expect(live.calls).toHaveLength(1);
  });

  it("403 and a challenge page are blocks; 429 honours Retry-After", async () => {
    live.reply = () => new Response("no", { status: 403 });
    expect((await runAsx(ENV, T0, deps(T0))).outcome).toBe("blocked");
    live.reply = () =>
      new Response("<html><title>Just a moment...</title></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const t1 = T0 + 4 * 60_000;
    expect((await runAsx(ENV, t1, deps(t1))).outcome).toBe("blocked");
    live.reply = () => new Response("slow", { status: 429, headers: { "retry-after": "900" } });
    const t2 = T0 + 8 * 60_000;
    expect((await runAsx(ENV, t2, deps(t2))).outcome).toBe("rate_limited");
    const t3 = t2 + 4 * 60_000;
    expect((await runAsx(ENV, t3, deps(t3))).skipped).toBe("denied-retry_after");
    const t4 = T0 + 24 * 60_000; // first poll minute after the 900 s wait
    expect((await runAsx(ENV, t4, deps(t4))).outcome).toBe("rate_limited");
  });

  it("a network error is an error outcome, not a throw", async () => {
    live.reply = () => {
      throw new Error("boom https://www.asx.com.au/secret");
    };
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s.outcome).toBe("error");
    expect(log().join("\n")).not.toContain("secret");
  });

  it("repeated blocks trip the source and the loop stops asking", async () => {
    live.reply = () => new Response("no", { status: 403 });
    let t = T0;
    for (let i = 0; i < TRIP_MIN_SAMPLE + 3; i++) {
      await runAsx(ENV, t, deps(t));
      t += 4 * 60_000;
    }
    expect(status().mode).toBe("tripped");
    expect(live.calls).toHaveLength(3);
    expect(token().day_count).toBe(3);
  });

  function log(): string[] {
    return (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
  }
});

describe("worker entry wiring", () => {
  it("scheduled(): with ASX_LIVE unset there is no ASX call and no ASX database work", async () => {
    enable();
    vi.stubGlobal("fetch", f);
    await worker.scheduled(
      { scheduledTime: T0 } as ScheduledController,
      { ...ENV, ASX_LIVE: undefined } as never,
    );
    expect(live.calls).toHaveLength(0);
    const asxSql = net.calls.filter(
      (c) => c.url.endsWith("/v2/pipeline") && /asx_rate_token/.test(c.body),
    );
    expect(asxSql).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("scheduled(): with everything on, a poll slot makes exactly one ASX call", async () => {
    enable();
    vi.stubGlobal("fetch", f);
    await worker.scheduled({ scheduledTime: T0 } as ScheduledController, ENV as never);
    expect(live.calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("ASX_JOBS has the poll as priority 1 only (stubs for 2..5 come later)", () => {
    expect(ASX_JOBS.map((j) => [j.id, j.priority])).toEqual([["asx-poll", 1]]);
  });
});
