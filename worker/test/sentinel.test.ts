// M5 T5 (D-100 draft; PLT-018, PLT-075, NFR-002, decision 36): the Worker's Sentinel hand-off.
// Real SQLite via node:sqlite; no network anywhere (ASX and the app are local fakes). Covers the
// signed hand-off, the unchanged-hash skip, the NFR-002 counters, delivery retries, blind
// detection across both DST changes, and that nothing is contacted unless every switch is on.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLIND_ALERT_MIN,
  SENTINEL_BODY_MAX_BYTES,
  incidentUrl,
  isBlind,
  pollKind,
  sentinelUrl,
  sha256Hex,
} from "../src/asx/sentinel";
import { ASX_ANNOUNCEMENTS_URL } from "../src/asx/request";
import { runAsx, type AsxEnv } from "../src/asx/slots";
import { sydneyLocal } from "../src/localtime";
import { TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const UA = "praxis-sentinel-test (contact: owner@example.test)";
const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const ENV: AsxEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  ASX_LIVE: "1",
  ASX_USER_AGENT: UA,
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: SECRET,
};
// Tuesday 2026-10-13 10:00 AEDT (UTC+11): a poll minute.
const T0 = Date.UTC(2026, 9, 12, 23, 0, 0);
const POLL = 4 * 60_000;
const DATE = "2026-10-13";

const feedBody = (n: number) => JSON.stringify({ data: [{ id: `x${n}`, code: "ZZAA" }] });

let db: DatabaseSync;
let net: Net;
let asx: { calls: { url: string; init: RequestInit }[]; reply: () => Response };
let app: { calls: { url: string; init: RequestInit }[]; reply: () => Response };
let f: typeof fetch;
// How the fake app answers the incident route: "route" opens the incident like the real route does.
let incidentMode: "route" | "fail";
const INCIDENT_PATH = "/api/internal/incident";
const ingestCalls = () => app.calls.filter((c) => c.url.endsWith("/api/internal/sentinel-ingest"));
const incidentCalls = () => app.calls.filter((c) => c.url.endsWith(INCIDENT_PATH));

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const enable = () => setState("asx_enabled", '"1"');
const deps = (now: number) => ({ fetch: f, nowMs: () => now });
const feed =
  (body: string, etag = '"v1"') =>
  () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json", etag } });
const pollDay = () =>
  rows(
    db,
    "SELECT d, scheduled, ok, not_modified, failed, blocked, max_gap_s, last_ok_at FROM sentinel_poll_day",
  );
const state = (key: string) =>
  rows(db, "SELECT value_json FROM worker_state WHERE key = ?", key).map((r) => r.value_json);
const incidents = () => rows(db, "SELECT severity, kind, resolved_at FROM incident ORDER BY id");

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

beforeEach(() => {
  db = makeDb();
  net = makeNet(db);
  asx = { calls: [], reply: feed(feedBody(1)) };
  app = { calls: [], reply: () => Response.json({ new: 1, assessed: 1, carried: 0 }) };
  incidentMode = "route";
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://www.asx.com.au/")) {
      asx.calls.push({ url, init: init ?? {} });
      return asx.reply();
    }
    if (url.startsWith(APP)) {
      app.calls.push({ url, init: init ?? {} });
      if (url.endsWith(INCIDENT_PATH)) {
        if (incidentMode === "fail") return new Response("no", { status: 500 });
        db.prepare(
          "INSERT INTO incident (at, severity, kind, detail_json) SELECT ?, 'S2', 'sentinel_blind', '{}' " +
            "WHERE NOT EXISTS (SELECT 1 FROM incident WHERE kind = 'sentinel_blind' AND resolved_at IS NULL)",
        ).run(new Date().toISOString());
        return Response.json({ opened: true, severity: "S2", email: "sent" });
      }
      return app.reply();
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("pure helpers", () => {
  it("sha256Hex matches the known answer", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("sentinelUrl is https only and keeps only the origin", () => {
    expect(sentinelUrl("https://x.test/some/path?q=1")).toBe(
      "https://x.test/api/internal/sentinel-ingest",
    );
    for (const bad of [undefined, "", "  ", "http://x.test", "ftp://x.test", "nonsense"]) {
      expect(sentinelUrl(bad)).toBeNull();
    }
  });

  it("incidentUrl is the https origin plus the incident route, else null", () => {
    expect(incidentUrl("https://x.test/some/path")).toBe("https://x.test/api/internal/incident");
    for (const bad of [undefined, "", "http://x.test", "nonsense"])
      expect(incidentUrl(bad)).toBeNull();
  });

  it("pollKind: 304 is a successful not_modified; rate limit and error are failed", () => {
    expect(pollKind("ok", 200)).toBe("ok");
    expect(pollKind("ok", 304)).toBe("not_modified");
    expect(pollKind("blocked", 403)).toBe("blocked");
    expect(pollKind("rate_limited", 429)).toBe("failed");
    expect(pollKind("error", null)).toBe("failed");
    expect(pollKind(null, null)).toBe("denied");
  });
});

describe("blind detection (PLT-018, decision 17) across DST (D-059/D-060)", () => {
  // The first Monday after each change: 2026-10-05 is AEDT (DST began Sun 4 Oct), 2026-04-06 is AEST
  // (DST ended Sun 5 Apr). 2026-03-10 is an ordinary AEDT day, 2026-07-07 an ordinary AEST day.
  const days: [string, number][] = [
    ["first Monday of AEDT", Date.UTC(2026, 9, 4, 20, 0, 0)], // 07:00 local
    ["first Monday of AEST", Date.UTC(2026, 3, 5, 21, 0, 0)], // 07:00 local
    ["ordinary AEDT day", Date.UTC(2026, 2, 9, 20, 0, 0)],
    ["ordinary AEST day", Date.UTC(2026, 6, 6, 21, 0, 0)],
  ];
  const at = (start: number, minuteOfDay: number) => start + (minuteOfDay - 420) * 60_000;

  it.each(days)(
    "%s: 07:00 local is MAP start; no poll yet blinds at exactly 15 minutes",
    (_n, s) => {
      expect(sydneyLocal(s).minute).toBe(420);
      for (const [min, blind] of [
        [420, false],
        [434, false],
        [435, true],
        [500, true],
      ] as const) {
        const now = at(s, min);
        expect(sydneyLocal(now).minute).toBe(min);
        expect(isBlind(now, min, null), `${_n} ${min}`).toBe(blind);
      }
      expect(BLIND_ALERT_MIN).toBe(15);
    },
  );

  it.each(days)(
    "%s: a success moves the reference; 14 min after it is fine, 15 is blind",
    (_n, s) => {
      const ok = at(s, 600); // 10:00
      expect(isBlind(at(s, 614), 614, ok)).toBe(false);
      expect(isBlind(at(s, 615), 615, ok)).toBe(true);
      expect(isBlind(at(s, 1170), 1170, at(s, 1160))).toBe(false); // 19:30, last ok 10 min ago
    },
  );

  it.each(days)(
    "%s: overnight silence does not count and MAP hours are the only window",
    (_n, s) => {
      const yesterdayEvening = s - 11 * 3_600_000; // 20:00 the day before
      expect(isBlind(at(s, 420), 420, yesterdayEvening)).toBe(false); // first poll of the day
      expect(isBlind(at(s, 419), 419, null)).toBe(false); // 06:59
      expect(isBlind(at(s, 1171), 1171, null)).toBe(false); // 19:31
      expect(isBlind(at(s, 1170), 1170, at(s, 700))).toBe(true); // 19:30 is inside
    },
  );
});

describe("runAsx: the Sentinel hand-off", () => {
  beforeEach(() => enable());

  it("a changed body is hashed and handed over once, signed (HMAC + timestamp + nonce)", async () => {
    const body = feedBody(1);
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s).toMatchObject({
      outcome: "ok",
      fetched: 1,
      delivered: 200,
      requests: 3,
      blind: false,
    });
    expect(asx.calls).toHaveLength(1);
    expect(asx.calls[0].url).toBe(ASX_ANNOUNCEMENTS_URL);
    expect(app.calls).toHaveLength(1);
    const call = app.calls[0];
    expect(call.url).toBe(`${APP}/api/internal/sentinel-ingest`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const raw = String(call.init.body);
    const j = JSON.parse(raw) as Record<string, unknown>;
    expect(j).toEqual({
      purpose: "sentinel-ingest",
      env: "production",
      d: DATE,
      sha: await sha256Hex(body),
      feed: body,
    });
    const h = call.init.headers as Record<string, string>;
    expect(h["X-Praxis-Timestamp"]).toBe(String(Math.floor(T0 / 1000)));
    expect(h["X-Praxis-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(h["X-Praxis-Signature"]).toBe(
      await hmacHex(SECRET, `${h["X-Praxis-Timestamp"]}.${h["X-Praxis-Nonce"]}.${raw}`),
    );
    expect(JSON.stringify(h)).not.toContain(SECRET);
    expect(state("sentinel:last_sha")).toEqual([JSON.stringify(await sha256Hex(body))]);
    expect(state("asx:etag")).toHaveLength(1);
  });

  it("an unchanged body (same hash, even with a new ETag) is not posted again", async () => {
    await runAsx(ENV, T0, deps(T0));
    asx.reply = feed(feedBody(1), '"v2"');
    const t1 = T0 + POLL;
    const s = await runAsx(ENV, t1, deps(t1));
    expect(s).toMatchObject({ outcome: "ok", delivered: null });
    expect(app.calls).toHaveLength(1);
    expect(pollDay()[0]).toMatchObject({ scheduled: 2, ok: 2, not_modified: 0 });
    expect(state("asx:etag")).toEqual([JSON.stringify('"v2"')]);
  });

  it("a different body is posted; a 304 counts as not_modified and posts nothing", async () => {
    await runAsx(ENV, T0, deps(T0));
    asx.reply = feed(feedBody(2), '"v2"');
    const t1 = T0 + POLL;
    expect((await runAsx(ENV, t1, deps(t1))).delivered).toBe(200);
    expect(app.calls).toHaveLength(2);
    asx.reply = () => new Response(null, { status: 304 });
    const t2 = t1 + POLL;
    expect(await runAsx(ENV, t2, deps(t2))).toMatchObject({ outcome: "ok", delivered: null });
    expect(app.calls).toHaveLength(2);
    expect(pollDay()[0]).toMatchObject({
      scheduled: 3,
      ok: 2,
      not_modified: 1,
      failed: 0,
      blocked: 0,
    });
  });

  it("NFR-002 counters: scheduled, ok, blocked, failed, last_ok_at and max_gap_s", async () => {
    await runAsx(ENV, T0, deps(T0)); // ok at 10:00
    asx.reply = () => new Response("no", { status: 403 });
    await runAsx(ENV, T0 + POLL, deps(T0 + POLL)); // blocked
    asx.reply = () => new Response("oops", { status: 500 });
    await runAsx(ENV, T0 + 2 * POLL, deps(T0 + 2 * POLL)); // failed
    asx.reply = feed(feedBody(1));
    const t3 = T0 + 3 * POLL;
    await runAsx(ENV, t3, deps(t3)); // ok at 10:12
    const d = pollDay();
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      d: DATE,
      scheduled: 4,
      ok: 2,
      not_modified: 0,
      failed: 1,
      blocked: 1,
      max_gap_s: 720,
      last_ok_at: new Date(t3).toISOString(),
    });
  });

  it("a token refusal counts as scheduled only and makes no ASX call", async () => {
    await runAsx(ENV, T0, deps(T0));
    const s = await runAsx(ENV, T0 + POLL, deps(T0 + 30_000)); // database clock inside 65 s
    expect(s.skipped).toBe("denied-spacing");
    expect(asx.calls).toHaveLength(1);
    expect(pollDay()[0]).toMatchObject({ scheduled: 2, ok: 1, failed: 0, blocked: 0 });
  });

  it("delivery failure: the ETag is withheld, the body is offered again, dropped after 3 attempts", async () => {
    app.reply = () => new Response("nope", { status: 503 });
    const body = feedBody(1);
    const sha = await sha256Hex(body);
    const s1 = await runAsx(ENV, T0, deps(T0));
    expect(s1).toMatchObject({ outcome: "ok", delivered: 503 });
    expect(state("asx:etag")).toEqual([]); // not remembered: the next fetch is unconditional
    expect(state("sentinel:fail")).toEqual([JSON.stringify({ sha, n: 1 })]);
    expect(state("sentinel:last_sha")).toEqual([]);
    expect(incidents()).toEqual([]);

    const t1 = T0 + POLL;
    expect((await runAsx(ENV, t1, deps(t1))).delivered).toBe(503);
    expect(state("sentinel:fail")).toEqual([JSON.stringify({ sha, n: 2 })]);
    expect((asx.calls[1].init.headers as Record<string, string>)["If-None-Match"]).toBeUndefined();

    const t2 = t1 + POLL;
    expect((await runAsx(ENV, t2, deps(t2))).delivered).toBe(503);
    expect(app.calls).toHaveLength(3);
    expect(incidents()).toEqual([
      { severity: "S3", kind: "sentinel_ingest_failed", resolved_at: null },
    ]);
    expect(state("sentinel:last_sha")).toEqual([JSON.stringify(sha)]);
    expect(state("sentinel:fail")).toEqual([]);
    expect(state("asx:etag")).toHaveLength(1); // dropped: the ETag is kept so it is not refetched

    const t3 = t2 + POLL;
    expect((await runAsx(ENV, t3, deps(t3))).delivered).toBeNull(); // dropped body is not re-offered
    expect(app.calls).toHaveLength(3);
  });

  it("a network error while posting is a failed attempt, not a throw", async () => {
    app.reply = () => {
      throw new Error(`boom ${APP}/secret`);
    };
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s.delivered).toBeNull();
    expect(state("sentinel:fail")).toHaveLength(1);
    expect(state("asx:etag")).toEqual([]);
    expect(
      (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .join("\n"),
    ).not.toContain("secret");
  });

  it("a body over 256 KB is never handed over; the poll counts as failed", async () => {
    asx.reply = feed("x".repeat(SENTINEL_BODY_MAX_BYTES + 1));
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s.outcome).toBe("error");
    expect(ingestCalls()).toHaveLength(0);
    expect(pollDay()[0]).toMatchObject({ scheduled: 1, ok: 0, failed: 1 });
    asx.reply = () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(SENTINEL_BODY_MAX_BYTES + 1) },
      });
    const t1 = T0 + POLL;
    expect((await runAsx(ENV, t1, deps(t1))).outcome).toBe("error");
    expect(ingestCalls()).toHaveLength(0);
  });

  it("no app configured: nothing is posted and the ETag is withheld so the body is not lost", async () => {
    const envs = [
      { ...ENV, APP_BASE_URL: undefined },
      { ...ENV, WORKER_HMAC_SECRET: undefined },
      { ...ENV, APP_BASE_URL: "http://insecure.test" },
    ];
    for (const [i, env] of envs.entries()) {
      const t = T0 + i * POLL;
      const s = await runAsx(env, t, deps(t));
      expect(s.outcome).toBe("ok");
      expect(app.calls).toHaveLength(0);
      expect(state("asx:etag")).toEqual([]);
    }
  });
});

describe("runAsx: blind state for the incident path", () => {
  beforeEach(() => enable());

  it("15 minutes of failed polls in MAP hours open ONE S2 sentinel_blind incident", async () => {
    // 07:00 local start; every poll fails (500).
    const start = Date.UTC(2026, 9, 12, 20, 0, 0); // Tue 2026-10-13 07:00 AEDT
    asx.reply = () => new Response("oops", { status: 500 });
    const seen: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const t = start + i * POLL; // 07:00, 07:04, ... 07:20
      seen.push((await runAsx(ENV, t, deps(t))).blind);
    }
    // 07:12 is 12 min in, 07:16 is 16 min: the first attempt at or after 15 min is blind.
    expect(seen).toEqual([false, false, false, false, true, true]);
    expect(incidents()).toEqual([{ severity: "S2", kind: "sentinel_blind", resolved_at: null }]);
  });

  it("a success resets the window; a lone failure is not blind", async () => {
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    asx.reply = () => new Response("oops", { status: 500 });
    await runAsx(ENV, start, deps(start));
    asx.reply = feed(feedBody(1));
    const t1 = start + 3 * POLL; // 07:12 ok
    expect((await runAsx(ENV, t1, deps(t1))).blind).toBe(false);
    asx.reply = () => new Response("oops", { status: 500 });
    const t2 = t1 + 3 * POLL; // 07:24, 12 min after the success
    expect((await runAsx(ENV, t2, deps(t2))).blind).toBe(false);
    expect(incidents()).toEqual([]);
  });

  it("a token refusal also counts toward blindness (the poll was due and made no request)", async () => {
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    db.prepare("UPDATE source_status SET mode = 'off' WHERE source = 'asx_announcements'").run();
    const t = start + 5 * POLL; // 07:20
    const s = await runAsx(ENV, t, deps(t));
    expect(s.skipped).toBe("denied-source_off");
    expect(s.blind).toBe(true);
    expect(incidents()).toHaveLength(1);
  });

  it("the Worker asks the app, signed, to open the incident (the app emails; the Worker never does)", async () => {
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    asx.reply = () => new Response("oops", { status: 500 });
    for (let i = 0; i < 5; i++) {
      const t = start + i * POLL;
      await runAsx(ENV, t, deps(t));
    }
    const calls = incidentCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const call = calls[0];
    expect(call.url).toBe(`${APP}/api/internal/incident`);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const raw = String(call.init.body);
    expect(JSON.parse(raw)).toEqual({
      purpose: "incident",
      env: "production",
      d: DATE,
      kind: "sentinel_blind",
      window_min: BLIND_ALERT_MIN,
    });
    const h = call.init.headers as Record<string, string>;
    expect(h["X-Praxis-Signature"]).toBe(
      await hmacHex(SECRET, `${h["X-Praxis-Timestamp"]}.${h["X-Praxis-Nonce"]}.${raw}`),
    );
    expect(JSON.stringify(h)).not.toContain(SECRET);
    expect(incidents()).toHaveLength(1); // one open incident, whatever the number of asks
  });

  it("when the app does not answer 200 the in-app incident is still written (blindness is never lost)", async () => {
    incidentMode = "fail";
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    asx.reply = () => new Response("oops", { status: 500 });
    for (let i = 0; i < 5; i++) {
      const t = start + i * POLL;
      await runAsx(ENV, t, deps(t));
    }
    expect(incidentCalls().length).toBeGreaterThanOrEqual(1);
    expect(incidents()).toEqual([{ severity: "S2", kind: "sentinel_blind", resolved_at: null }]);
  });

  it("no app configured: no ask is made and the in-app incident is written", async () => {
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    asx.reply = () => new Response("oops", { status: 500 });
    for (let i = 0; i < 5; i++) {
      const t = start + i * POLL;
      await runAsx({ ...ENV, APP_BASE_URL: undefined }, t, deps(t));
    }
    expect(incidentCalls()).toHaveLength(0);
    expect(incidents()).toHaveLength(1);
  });

  it("not blind: the app is never asked", async () => {
    const start = Date.UTC(2026, 9, 12, 20, 0, 0);
    asx.reply = () => new Response("oops", { status: 500 });
    await runAsx(ENV, start, deps(start));
    expect(incidentCalls()).toHaveLength(0);
    expect(incidents()).toEqual([]);
  });

  it("blind detection works the same on the AEST side of the year", async () => {
    const start = Date.UTC(2026, 3, 6, 21, 0, 0); // Tue 2026-04-07 07:00 AEST (6 Apr is Easter Monday)
    asx.reply = () => new Response("oops", { status: 500 });
    let last = false;
    for (let i = 0; i < 5; i++) {
      const t = start + i * POLL;
      last = (await runAsx(ENV, t, deps(t))).blind;
    }
    expect(last).toBe(true);
    expect(incidents()).toHaveLength(1);
  });
});

describe("runAsx: nothing is contacted unless every switch is on", () => {
  const none = () => {
    expect(asx.calls).toHaveLength(0);
    expect(app.calls).toHaveLength(0);
    expect(rows(db, "SELECT 1 FROM sentinel_poll_day")).toHaveLength(0);
  };

  it("ASX_LIVE off: no network call at all, no database work, no counters", async () => {
    enable();
    const s = await runAsx({ ...ENV, ASX_LIVE: undefined }, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "live-off", requests: 0, fetched: 0, delivered: null });
    expect(net.calls).toHaveLength(0);
    none();
  });

  it("asx_enabled off (the default): one read, no ASX call, no post, no counters", async () => {
    const s = await runAsx(ENV, T0, deps(T0));
    expect(s).toMatchObject({ skipped: "disabled", requests: 1, fetched: 0 });
    none();
    expect(incidents()).toEqual([]); // switching the feed off is not "blind"
  });

  it("staging never fetches, even with ASX_LIVE and the kill switch on", async () => {
    enable();
    for (const e of ["staging", "preview", "", "Production"]) {
      expect((await runAsx({ ...ENV, PRAXIS_ENV: e }, T0, deps(T0))).skipped).toBe(
        "not-production",
      );
    }
    expect(net.calls).toHaveLength(0);
    none();
  });

  it("no identifying User-Agent, market off, holiday: no ASX call and no post", async () => {
    enable();
    expect((await runAsx({ ...ENV, ASX_USER_AGENT: "Mozilla/5.0 x" }, T0, deps(T0))).skipped).toBe(
      "no-user-agent",
    );
    db.prepare("UPDATE market SET mode = 'off' WHERE code = 'AU'").run();
    expect((await runAsx(ENV, T0, deps(T0))).skipped).toBe("market-off");
    none();
  });
});
