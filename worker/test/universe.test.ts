// M2 T11 (D-067): the Worker's universe slot. Real SQLite via node:sqlite; no network anywhere (the
// ASX URL and the app are answered by local fakes, and most tests assert they were never called).
// Synthetic CSV text only (SEC-110).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { candidateSlots } from "../src/clock";
import { ASX_LISTED_COMPANIES_URL, buildListedCompaniesRequest } from "../src/asx/request";
import {
  MAX_CSV_BYTES,
  UNIVERSE_PRIORITY,
  UNIVERSE_SLOT_MIN,
  runUniverse,
  universeDue,
  type UniverseEnv,
} from "../src/asx/universe";
import { ASX_JOBS, pollDue } from "../src/asx/slots";
import { PRIORITY_LIMITS } from "../src/asx/policy";
import { AU_SLOTS, DISPATCHABLE_WORKFLOWS } from "../src/schedule";
import { sydneyLocal } from "../src/localtime";
import { TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const UA = "praxis-sentinel-test (contact: owner@example.test)";
const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const ENV: UniverseEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  ASX_LIVE: "1",
  ASX_USER_AGENT: UA,
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: SECRET,
};
const CSV =
  "Synthetic listed companies as at Tue Oct 13 2026\n\nCompany name,ASX code,GICS industry group\n" +
  "Synthetic Alpha Ltd,ZZAA,Materials\nSynthetic Beta Ltd,ZZBB,Banks\n";

// Tuesday 2026-10-13 07:30 AEDT (UTC+11).
const T0 = Date.UTC(2026, 9, 12, 20, 30, 0);
const DATE = "2026-10-13";

/** Independent HMAC-SHA256 (WebCrypto) so the Worker signer is checked against a second code path. */
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
let asx: { calls: { url: string; init: RequestInit }[]; reply: () => Response | Promise<Response> };
let app: { calls: { url: string; init: RequestInit }[]; reply: () => Response | Promise<Response> };
let f: typeof fetch;

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const reg = (source: string, status: string) =>
  db.prepare("UPDATE source_register SET status = ? WHERE source = ?").run(status, source);
/** Everything on: the only state in which the universe file may be fetched. */
const allOn = () => {
  setState("asx_enabled", '"1"');
  reg("asx_announcements", "enabled");
  reg("asx_listed_companies", "enabled");
};
const token = () =>
  db.prepare("SELECT last_request_at, day_count_date, day_count FROM asx_rate_token").all()[0] as {
    last_request_at: string | null;
    day_count_date: string | null;
    day_count: number;
  };
const outcomes = () =>
  rows(db, "SELECT key, value_json FROM worker_state WHERE key LIKE 'asxout:%'") as {
    key: string;
    value_json: string;
  }[];
const log = () => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
const deps = (now: number) => ({ fetch: f, nowMs: () => now });
const csvResponse = (body = CSV, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/csv", ...headers } });

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  asx = { calls: [], reply: () => csvResponse() };
  app = {
    calls: [],
    reply: () => Response.json({ result: "applied" }, { status: 200 }),
  };
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).origin === "https://www.asx.com.au") {
      asx.calls.push({ url, init: init ?? {} });
      return asx.reply();
    }
    if (new URL(url).origin === APP) {
      app.calls.push({ url, init: init ?? {} });
      return app.reply();
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the universe slot (schedule and arithmetic)", () => {
  const at = (h: number, m: number, day = 13) =>
    sydneyLocal(Date.UTC(2026, 9, day - 1, h - 11 + 24, m));

  it("is a Worker-run, trading-day, market-bound slot at 07:30, priority 3, not dispatched by the clock", () => {
    const s = AU_SLOTS.find((x) => x.id === "universe");
    expect(s).toMatchObject({
      time: "07:30",
      runner: "worker",
      workflow: null,
      tradingDaysOnly: true,
      marketBound: true,
      priority: UNIVERSE_PRIORITY,
      enabled: false,
    });
    expect(s?.minute).toBe(UNIVERSE_SLOT_MIN);
    expect(UNIVERSE_PRIORITY).toBe(3);
    expect(DISPATCHABLE_WORKFLOWS.some((w) => /universe/.test(w))).toBe(false);
    // The Actions clock never picks a Worker-run slot.
    for (let m = 0; m < 1440; m += 1) {
      const c = candidateSlots({ ...at(0, 0), minute: m });
      expect(c.some((x) => x.id === "universe")).toBe(false);
    }
  });

  it("is due only at 07:30 on weekdays, on an even minute", () => {
    expect(UNIVERSE_SLOT_MIN % 2).toBe(0);
    expect(universeDue(at(7, 30))).toBe(true);
    for (const [h, m] of [
      [7, 28],
      [7, 29],
      [7, 31],
      [7, 32],
      [7, 0],
      [19, 30],
    ]) {
      expect(universeDue(at(h, m)), `${h}:${m}`).toBe(false);
    }
    expect(universeDue(sydneyLocal(Date.UTC(2026, 9, 9, 20, 30, 0)))).toBe(false); // Saturday
    expect(universeDue(sydneyLocal(Date.UTC(2026, 9, 10, 20, 30, 0)))).toBe(false); // Sunday
  });

  it("sits at least 65 s from every other ASX-touching slot (polls, pre-open)", () => {
    expect(pollDue(at(7, 30))).toBe(false);
    expect(pollDue(at(7, 28))).toBe(true);
    expect(pollDue(at(7, 32))).toBe(true);
    for (let m = 7 * 60; m <= 19 * 60 + 30; m += 4) {
      expect(Math.abs(m - UNIVERSE_SLOT_MIN) * 60).toBeGreaterThanOrEqual(65);
    }
    const pre = AU_SLOTS.find((x) => x.id === "pre-open")!.minute;
    expect(Math.abs(pre - UNIVERSE_SLOT_MIN) * 60).toBeGreaterThanOrEqual(65);
    // And the poll's job list is unchanged: the universe is its own consumer.
    expect(ASX_JOBS.map((j) => j.id)).toEqual(["asx-poll"]);
  });

  it("priority 3 is reserved below the cap, like the other batch priorities", () => {
    expect(PRIORITY_LIMITS[3]).toBeLessThan(720);
  });
});

describe("request building", () => {
  it("identifying User-Agent, plain GET, no cookies, no redirects, https, fixed URL", () => {
    const r = buildListedCompaniesRequest(UA)!;
    expect(r.url).toBe(ASX_LISTED_COMPANIES_URL);
    expect(new URL(r.url).origin).toBe("https://www.asx.com.au");
    expect(r.init.method).toBe("GET");
    expect(r.init.redirect).toBe("manual");
    expect(r.init.headers["User-Agent"]).toBe(UA);
    expect(Object.keys(r.init.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(r.init.headers).not.toHaveProperty("If-None-Match");
    for (const ua of [undefined, "", "   ", "Mozilla/5.0 (X11)", "bad\nua", "x".repeat(201), 5]) {
      expect(buildListedCompaniesRequest(ua)).toBeNull();
    }
  });
});

describe("runUniverse: nothing happens unless everything is on", () => {
  it("not the universe minute: zero database, zero network, no log", async () => {
    allOn();
    for (const t of [
      T0 - 120_000, // 07:28
      T0 + 120_000, // 07:32
      T0 + 60_000, // 07:31
      Date.UTC(2026, 9, 9, 20, 30, 0), // Saturday 07:30
    ]) {
      const s = await runUniverse(ENV, t, deps(t));
      expect(s).toMatchObject({ skipped: null, requests: 0, fetched: 0 });
    }
    expect(net.calls).toHaveLength(0);
    expect(asx.calls).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
    expect(log()).toEqual([]);
  });

  it("ASX_LIVE unset: no network, no database, one log line (default)", async () => {
    allOn();
    const s = await runUniverse({ ...ENV, ASX_LIVE: undefined }, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "live-off", requests: 0, fetched: 0 });
    expect(net.calls).toHaveLength(0);
    expect(asx.calls).toHaveLength(0);
    expect(log()).toContain("universe: skipped (ASX_LIVE off)");
  });

  it.each(["0", "true", "yes", ""])("ASX_LIVE = %j is off", async (v) => {
    allOn();
    expect((await runUniverse({ ...ENV, ASX_LIVE: v }, T0, deps(T0))).skipped).toBe("live-off");
    expect(net.calls).toHaveLength(0);
  });

  it("staging never contacts ASX even with everything else on", async () => {
    allOn();
    for (const e of ["staging", "preview", "", "Production"]) {
      expect((await runUniverse({ ...ENV, PRAXIS_ENV: e }, T0, deps(T0))).skipped).toBe(
        "not-production",
      );
    }
    expect(net.calls).toHaveLength(0);
    expect(asx.calls).toHaveLength(0);
    expect(log()).toContain("universe: skipped (not production)");
  });

  it("database not configured, no identifying user agent, app or secret missing: no calls at all", async () => {
    allOn();
    const cases: [Partial<UniverseEnv>, string, string][] = [
      [{ TURSO_MAIN_URL: undefined }, "no-db", "universe: skipped (database not configured)"],
      [{ TURSO_MAIN_TOKEN: "" }, "no-db", "universe: skipped (database not configured)"],
      [
        { ASX_USER_AGENT: undefined },
        "no-user-agent",
        "universe: skipped (no identifying user agent)",
      ],
      [
        { ASX_USER_AGENT: "Mozilla/5.0 (X11)" },
        "no-user-agent",
        "universe: skipped (no identifying user agent)",
      ],
      [{ APP_BASE_URL: undefined }, "no-app", "universe: skipped (app not configured)"],
      [
        { APP_BASE_URL: "http://praxis-app.example.test" },
        "no-app",
        "universe: skipped (app not configured)",
      ],
      [{ APP_BASE_URL: "not a url" }, "no-app", "universe: skipped (app not configured)"],
      [{ WORKER_HMAC_SECRET: undefined }, "no-app", "universe: skipped (app not configured)"],
      [{ WORKER_HMAC_SECRET: "  " }, "no-app", "universe: skipped (app not configured)"],
    ];
    for (const [over, why, line] of cases) {
      const s = await runUniverse({ ...ENV, ...over }, T0, deps(T0));
      expect(s.skipped, line).toBe(why);
      expect(log()).toContain(line);
    }
    expect(net.calls).toHaveLength(0);
    expect(asx.calls).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
  });

  it("asx_enabled off (default): one read, no token, no ASX call", async () => {
    reg("asx_announcements", "enabled");
    reg("asx_listed_companies", "enabled");
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "disabled", requests: 1, fetched: 0 });
    expect(net.pipelines).toBe(1);
    expect(token().day_count).toBe(0);
    expect(asx.calls).toHaveLength(0);
    expect(log()).toContain("universe: skipped (asx_enabled off)");
  });

  it("market off or holiday: the token is not spent", async () => {
    allOn();
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    expect((await runUniverse(ENV, T0, deps(T0))).skipped).toBe("market-off");
    db.prepare("UPDATE market SET mode = 'data_only' WHERE code = 'AU'").run();
    const xmas = Date.UTC(2026, 11, 24, 20, 30, 0); // Friday 25 Dec 07:30 AEDT
    expect((await runUniverse(ENV, xmas, deps(xmas))).skipped).toBe("holiday");
    expect(token().day_count).toBe(0);
    expect(asx.calls).toHaveLength(0);
    expect(log()).toContain("universe: skipped (market off)");
    expect(log()).toContain("universe: skipped (holiday)");
  });

  it.each([
    ["asx_announcements", "pending"],
    ["asx_announcements", "disabled"],
    ["asx_listed_companies", "pending"],
    ["asx_listed_companies", "disabled"],
  ])("source %s %s: the file is not fetched and the token is not spent", async (src, status) => {
    allOn();
    reg(src, status);
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.skipped).toBe(
      src === "asx_announcements" ? "source-not-accepted" : "listed-not-accepted",
    );
    expect(s.requests).toBe(1);
    expect(token().day_count).toBe(0);
    expect(asx.calls).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
  });

  it("a missing register row is not accepted", async () => {
    allOn();
    db.prepare("DROP TRIGGER source_register_no_delete").run();
    db.prepare("DELETE FROM source_register WHERE source = 'asx_listed_companies'").run();
    expect((await runUniverse(ENV, T0, deps(T0))).skipped).toBe("listed-not-accepted");
    expect(asx.calls).toHaveLength(0);
  });

  it("tripped announcements source: refused at the token, nothing fetched", async () => {
    allOn();
    db.prepare(
      "UPDATE source_status SET mode = 'tripped' WHERE source = 'asx_announcements'",
    ).run();
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.skipped).toBe("denied-source_off");
    expect(asx.calls).toHaveLength(0);
  });

  it("a database failure on the read is a skip, not a throw", async () => {
    allOn();
    net.failPipeline = true;
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.skipped).toBe("db-error");
    expect(asx.calls).toHaveLength(0);
    expect(log()).toContain("universe: skipped (database error)");
  });

  it("every combination of the eight switches: only all-on contacts ASX", async () => {
    const names = ["live", "prod", "ua", "app", "secret", "enabled", "announce", "listed"] as const;
    let fetched = 0;
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const on = (n: (typeof names)[number]) => (mask & (1 << names.indexOf(n))) !== 0;
      db = makeDb({ sentinel: false }); // 256 databases: the poll tables are not needed here
      net = makeNet(db);
      asx.calls.length = 0;
      app.calls.length = 0;
      setState("asx_enabled", on("enabled") ? '"1"' : '"0"');
      reg("asx_announcements", on("announce") ? "enabled" : "pending");
      reg("asx_listed_companies", on("listed") ? "enabled" : "pending");
      const env: UniverseEnv = {
        ...ENV,
        ASX_LIVE: on("live") ? "1" : undefined,
        PRAXIS_ENV: on("prod") ? "production" : "staging",
        ASX_USER_AGENT: on("ua") ? UA : undefined,
        APP_BASE_URL: on("app") ? APP : undefined,
        WORKER_HMAC_SECRET: on("secret") ? SECRET : undefined,
      };
      await runUniverse(env, T0, deps(T0));
      const allOnMask = mask === (1 << names.length) - 1;
      expect(asx.calls.length, `mask ${mask}`).toBe(allOnMask ? 1 : 0);
      expect(app.calls.length, `mask ${mask}`).toBe(allOnMask ? 1 : 0);
      if (!allOnMask) expect(token().day_count, `mask ${mask}`).toBe(0);
      fetched += asx.calls.length;
    }
    expect(fetched).toBe(1);
  });
});

describe("runUniverse: a live import", () => {
  beforeEach(() => allOn());

  it("takes a priority 3 token, fetches the file once and posts it signed to the app", async () => {
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s).toMatchObject({
      skipped: null,
      outcome: "ok",
      tripped: false,
      fetched: 1,
      delivered: 200,
    });
    expect(s.requests).toBe(3); // read, token, outcome
    expect(token()).toMatchObject({ day_count: 1, day_count_date: DATE });
    expect(token().last_request_at).toBe(new Date(T0).toISOString());
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0].value_json).toBe('"ok"');

    // The one ASX request.
    expect(asx.calls).toHaveLength(1);
    expect(asx.calls[0].url).toBe(ASX_LISTED_COMPANIES_URL);
    const h = asx.calls[0].init.headers as Record<string, string>;
    expect(h["User-Agent"]).toBe(UA);
    expect(asx.calls[0].init.method).toBe("GET");
    expect(asx.calls[0].init.redirect).toBe("manual");

    // The one app request: exact URL, signature recomputed independently, body is the raw text.
    expect(app.calls).toHaveLength(1);
    const call = app.calls[0];
    expect(call.url).toBe(`${APP}/api/internal/universe-import`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const body = String(call.init.body);
    expect(JSON.parse(body)).toEqual({
      purpose: "universe-import",
      env: "production",
      d: DATE,
      csv: CSV,
    });
    const hh = call.init.headers as Record<string, string>;
    expect(hh["Content-Type"]).toBe("application/json");
    expect(hh["X-Praxis-Timestamp"]).toBe(String(Math.floor(T0 / 1000)));
    expect(hh["X-Praxis-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    const expected = await hmacHex(
      SECRET,
      `${hh["X-Praxis-Timestamp"]}.${hh["X-Praxis-Nonce"]}.${body}`,
    );
    expect(hh["X-Praxis-Signature"]).toBe(expected);
    expect(log()).toContain("universe: ok");
    expect(log()).toContain("universe: import accepted");
  });

  it("a second attempt inside 65 s is refused at the token: no ASX call, no post", async () => {
    await runUniverse(ENV, T0, deps(T0));
    const s = await runUniverse(ENV, T0, deps(T0 + 30_000));
    expect(s.skipped).toBe("denied-spacing");
    expect(asx.calls).toHaveLength(1);
    expect(app.calls).toHaveLength(1);
  });

  it("the priority 3 reservation holds: refused when the day count is at its limit", async () => {
    db.prepare("UPDATE asx_rate_token SET day_count_date = ?, day_count = ?").run(
      DATE,
      PRIORITY_LIMITS[3],
    );
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.skipped).toBe("denied-reserved");
    expect(asx.calls).toHaveLength(0);
  });

  it("kill switch flipped off between the read and the token: refused atomically", async () => {
    const real = f;
    f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v2/pipeline") && String(init?.body).includes("asx_rate_token")) {
        setState("asx_enabled", '"0"');
      }
      return real(input, init);
    }) as typeof fetch;
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.skipped).toBe("denied-disabled");
    expect(asx.calls).toHaveLength(0);
  });

  const html = { "content-type": "text/html" };
  it.each([
    ["403", () => new Response("no", { status: 403 }), "blocked"],
    [
      "challenge page",
      () => new Response("<html>Just a moment...</html>", { status: 200, headers: html }),
      "blocked",
    ],
    ["500", () => new Response("x", { status: 500 }), "error"],
    ["404", () => new Response("x", { status: 404 }), "error"],
    [
      "redirect",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/" },
        }),
      "error",
    ],
    ["html 200", () => new Response("<html>hello</html>", { status: 200, headers: html }), "error"],
    [
      "empty 200",
      () => new Response("", { status: 200, headers: { "content-type": "text/csv" } }),
      "error",
    ],
    ["304", () => new Response(null, { status: 304 }), "error"],
  ] as const)("%s: outcome %s recorded, nothing is posted", async (_n, reply, outcome) => {
    asx.reply = reply;
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.outcome).toBe(outcome);
    expect(app.calls).toHaveLength(0);
    expect(outcomes().map((o) => o.value_json)).toEqual([JSON.stringify(outcome)]);
    expect(token().day_count).toBe(1);
  });

  it("429 honours Retry-After and posts nothing", async () => {
    asx.reply = () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.outcome).toBe("rate_limited");
    expect(app.calls).toHaveLength(0);
    const next = db
      .prepare("SELECT value_json FROM worker_state WHERE key = 'asx:next_allowed_at'")
      .all() as { value_json: string }[];
    expect(next[0].value_json).toBe(JSON.stringify(new Date(T0 + 120_000).toISOString()));
  });

  it("a network error is an error outcome, not a throw", async () => {
    asx.reply = () => {
      throw new Error("boom TOPSECRET");
    };
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.outcome).toBe("error");
    expect(app.calls).toHaveLength(0);
    expect(JSON.stringify(log())).not.toContain("TOPSECRET");
  });

  it("size cap: a declared or actual body over 1 MB is an error and is never posted", async () => {
    asx.reply = () => csvResponse("x", { "content-length": String(MAX_CSV_BYTES + 1) });
    expect((await runUniverse(ENV, T0, deps(T0))).outcome).toBe("error");
    asx.reply = () => csvResponse("a".repeat(MAX_CSV_BYTES + 1));
    expect((await runUniverse(ENV, T0, deps(T0 + 70_000))).outcome).toBe("error");
    expect(app.calls).toHaveLength(0);
  });

  it("exactly 1 MB is posted", async () => {
    asx.reply = () => csvResponse("a".repeat(MAX_CSV_BYTES));
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.outcome).toBe("ok");
    expect(JSON.parse(String(app.calls[0].init.body)).csv).toHaveLength(MAX_CSV_BYTES);
  });

  it("a body that cannot be read is an error outcome", async () => {
    asx.reply = () => {
      const r = csvResponse();
      vi.spyOn(r, "text").mockRejectedValue(new Error("stream"));
      return r;
    };
    expect((await runUniverse(ENV, T0, deps(T0))).outcome).toBe("error");
    expect(app.calls).toHaveLength(0);
  });

  it("three consecutive blocks trip the source and write an S2 incident", async () => {
    asx.reply = () => new Response("no", { status: 403 });
    let last = await runUniverse(ENV, T0, deps(T0));
    for (let i = 1; i < 3; i++) last = await runUniverse(ENV, T0, deps(T0 + i * 70_000));
    expect(last.tripped).toBe(true);
    expect(
      db.prepare("SELECT mode FROM source_status WHERE source = 'asx_announcements'").all()[0],
    ).toMatchObject({ mode: "tripped" });
    expect(db.prepare("SELECT kind, severity FROM incident").all()).toEqual([
      { kind: "asx_block_trip", severity: "S2" },
    ]);
  });

  it("the app answer is logged as a status (and a known error word), never its body", async () => {
    app.reply = () =>
      Response.json({ error: "suspicious_shrink", csv: "LEAK-BODY" }, { status: 409 });
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.delivered).toBe(409);
    expect(log()).toContain("universe: import rejected (HTTP 409, suspicious_shrink)");
    app.reply = () => Response.json({ error: "weird LEAK-WORD" }, { status: 400 });
    await runUniverse(ENV, T0, deps(T0 + 70_000));
    expect(log()).toContain("universe: import rejected (HTTP 400)");
    app.reply = () => new Response("not json", { status: 401 });
    await runUniverse(ENV, T0, deps(T0 + 140_000));
    expect(log()).toContain("universe: import rejected (HTTP 401)");
    expect(JSON.stringify(log())).not.toContain("LEAK");
  });

  it("an app that cannot be reached is logged as not delivered, without throwing", async () => {
    app.reply = () => {
      throw new Error("network TOPSECRET");
    };
    const s = await runUniverse(ENV, T0, deps(T0));
    expect(s.delivered).toBeNull();
    expect(log()).toContain("universe: import not delivered");
    expect(JSON.stringify(log())).not.toContain("TOPSECRET");
  });

  it("no secret, header, URL or file content appears in any log line", async () => {
    await runUniverse(ENV, T0, deps(T0));
    app.reply = () => new Response("x", { status: 500 });
    await runUniverse(ENV, T0, deps(T0 + 70_000));
    const all = JSON.stringify(log());
    for (const secret of [
      SECRET,
      TURSO_TOKEN,
      TURSO_URL,
      UA,
      APP,
      "asx.com.au",
      "ZZAA",
      "Synthetic",
    ]) {
      expect(all, secret).not.toContain(secret);
    }
  });

  it("never throws, even when the environment is broken", async () => {
    const bad = {
      ...ENV,
      get ASX_LIVE(): string {
        throw new Error("env");
      },
    } as UniverseEnv;
    await expect(runUniverse(bad, T0, deps(T0))).resolves.toBeDefined();
    expect(log()).toContain("universe: error");
  });
});

describe("worker entry wiring", () => {
  it("scheduled() at 07:30 with everything on: one ASX call (the file), one signed post", async () => {
    allOn();
    vi.stubGlobal("fetch", f);
    await worker.scheduled({ scheduledTime: T0 } as ScheduledController, ENV as never);
    expect(asx.calls).toHaveLength(1);
    expect(asx.calls[0].url).toBe(ASX_LISTED_COMPANIES_URL);
    expect(app.calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("scheduled() with ASX_LIVE unset: no ASX call, no post, no ASX token work", async () => {
    allOn();
    vi.stubGlobal("fetch", f);
    await worker.scheduled(
      { scheduledTime: T0 } as ScheduledController,
      { ...ENV, ASX_LIVE: undefined } as never,
    );
    expect(asx.calls).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
    expect(net.calls.filter((c) => /asx_rate_token/.test(c.body))).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("a poll minute still makes only the poll request", async () => {
    allOn();
    vi.stubGlobal("fetch", f);
    asx.reply = () =>
      new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
    const poll = Date.UTC(2026, 9, 12, 20, 28, 0); // 07:28
    await worker.scheduled({ scheduledTime: poll } as ScheduledController, ENV as never);
    expect(asx.calls).toHaveLength(1);
    expect(asx.calls[0].url).not.toBe(ASX_LISTED_COMPANIES_URL);
    // the only app call is the Sentinel hand-off of the changed feed body (M5 T5), never the universe import
    expect(app.calls.map((c) => c.url)).toEqual([`${APP}/api/internal/sentinel-ingest`]);
    vi.unstubAllGlobals();
  });
});
