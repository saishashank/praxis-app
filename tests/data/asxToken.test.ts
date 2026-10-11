// @vitest-environment node
// DAT-122, DAT-123, DAT-127, D-047 (audit first), D-061 (M2 T4): ASX rate token read model and
// the Owner's trip reset; agreement between the Worker's policy copy and the app adapters
// (src/lib/data/sources/{asx,status}.ts); the Worker's SQL run on libsql (the engine used in
// production). No network: the pipeline is a local function over a temp libsql database.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  ASX_DAILY_CAP,
  ASX_MIN_SPACING_S,
  ASX_TRIP_MIN_SAMPLE,
  ASX_TRIP_PERCENT,
  ASX_TRIP_WINDOW_MS,
  loadAsxTokenView,
  resetAsxTrip,
} from "@/lib/data/asxToken";
import {
  AsxSourceError,
  buildAnnouncementsRequest,
  handleAnnouncementsResponse,
  isBlockSignal,
  looksLikeChallenge,
  validateUserAgent,
} from "@/lib/data/sources/asx";
import { mayFetch, SOURCES, type SourceMode } from "@/lib/data/sources/status";
import * as policy from "../../worker/src/asx/policy";
import { buildAsxRequest } from "../../worker/src/asx/request";
import { acquire, recordOutcome } from "../../worker/src/asx/token";

afterEach(cleanupTempDbs);

let main: Client;
let auth: Client;
let ownerId: number;
let editorId: number;
const ENV = { PII_HASH_KEY: KEY } as Record<string, string | undefined>;
const T0 = Date.UTC(2026, 9, 12, 23, 0, 0); // Tuesday 2026-10-13 10:00 AEDT
const NOW = new Date(T0 + 3_600_000);
const UA = "praxis-test (contact: owner@example.test)";

// Turso pipeline over a libsql client: the Worker's own SQL, executed by the production engine.
function pipelineFetch(db: Client): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const reqs = JSON.parse(String(init?.body)).requests as {
      type: string;
      stmt?: { sql: string; args?: { type: string; value?: string }[] };
    }[];
    const results: unknown[] = [];
    for (const r of reqs) {
      if (r.type !== "execute" || !r.stmt) {
        results.push({ type: "ok" });
        continue;
      }
      const args = (r.stmt.args ?? []).map((a) =>
        a.type === "null" ? null : a.type === "integer" ? Number(a.value) : (a.value ?? null),
      );
      const res = await db.execute({ sql: r.stmt.sql, args });
      const rows = res.rows.map((row) =>
        Array.from({ length: res.columns.length }, (_, i) => {
          const v = row[i];
          if (v === null || v === undefined) return { type: "null" };
          return typeof v === "number" || typeof v === "bigint"
            ? { type: "integer", value: String(v) }
            : { type: "text", value: String(v) };
        }),
      );
      results.push({
        type: "ok",
        response: { type: "execute", result: { rows, affected_row_count: res.rowsAffected } },
      });
    }
    return Response.json({ results });
  }) as typeof fetch;
}
const WENV = { TURSO_MAIN_URL: "libsql://x.turso.io", TURSO_MAIN_TOKEN: "t" };

const enable = () =>
  main.execute(
    "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('asx_enabled', '\"1\"', 'x') " +
      "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
  );
const mode = async () =>
  String(
    (await main.execute("SELECT mode FROM source_status WHERE source = 'asx_announcements'"))
      .rows[0].mode,
  );
const trip = async (f: typeof fetch) => {
  for (let i = 0; i < 9; i++) await recordOutcome(WENV, T0 + i * 65_000, "ok", f);
  await recordOutcome(WENV, T0 + 9 * 65_000, "blocked", f);
};

beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
});

describe("Worker policy copy agrees with the app (DAT-122 / DAT-123 / DAT-127)", () => {
  it("constants", () => {
    expect(ASX_MIN_SPACING_S * 1000).toBe(policy.MIN_SPACING_MS);
    expect(ASX_DAILY_CAP).toBe(policy.DAILY_CAP);
    expect(ASX_TRIP_PERCENT).toBe(policy.TRIP_PERCENT);
    expect(ASX_TRIP_WINDOW_MS).toBe(policy.TRIP_WINDOW_MS);
    expect(ASX_TRIP_MIN_SAMPLE).toBe(policy.TRIP_MIN_SAMPLE);
    expect(policy.ASX_SOURCE).toBe("asx_announcements");
    expect(SOURCES).toContain("asx");
  });

  it.each(["on", "off", "degraded", "tripped"] as SourceMode[])(
    "mayFetch(%s) equals mayFetchMode",
    (m) => {
      expect(policy.mayFetchMode(m)).toBe(mayFetch(m));
    },
  );
  it("an unknown or missing mode is not fetched (fail closed)", () => {
    expect(policy.mayFetchMode(null)).toBe(false);
    expect(policy.mayFetchMode("maybe")).toBe(false);
  });

  const html = { "content-type": "text/html" };
  const json = { "content-type": "application/json" };
  const cases: [string, number, Record<string, string>, string][] = [
    ["304", 304, {}, ""],
    ["200 list", 200, json, '{"data":[]}'],
    ["429", 429, { "retry-after": "120" }, ""],
    ["403", 403, {}, "no"],
    ["200 challenge", 200, html, "<html><title>Just a moment...</title></html>"],
    ["503 challenge", 503, html, "<!doctype html><body>Access Denied</body>"],
    ["500", 500, json, "{}"],
    ["301", 301, {}, ""],
  ];
  it.each(cases)("classify %s like handleAnnouncementsResponse", (_n, status, headers, body) => {
    let appOutcome: policy.Outcome;
    let appBlock = false;
    try {
      handleAnnouncementsResponse({ status, headers, body });
      appOutcome = "ok";
    } catch (e) {
      appBlock = isBlockSignal(e);
      const kind = (e as AsxSourceError).kind;
      appOutcome =
        kind === "blocked" || kind === "challenge"
          ? "blocked"
          : kind === "rate_limited"
            ? "rate_limited"
            : "error";
    }
    const w = policy.classifyResponse(status, headers["content-type"] ?? null, body);
    expect(w).toBe(appOutcome);
    expect(w === "blocked").toBe(appBlock);
    expect(policy.looksLikeChallenge(headers["content-type"] ?? null, body)).toBe(
      looksLikeChallenge({ status, headers, body }),
    );
  });

  it.each(["0", "30", "120", "86400", "abc", "-5"])("Retry-After %j parses alike", (v) => {
    let appS: number | null = null;
    try {
      handleAnnouncementsResponse({ status: 429, headers: { "Retry-After": v }, body: "" });
    } catch (e) {
      appS = (e as AsxSourceError).retryAfterS;
    }
    expect(policy.parseRetryAfter(v)).toBe(appS);
  });

  it("request: same URL, headers and refusals as buildAnnouncementsRequest", () => {
    const a = buildAnnouncementsRequest({ userAgent: UA, etag: '"e1"' });
    const w = buildAsxRequest(UA, '"e1"');
    expect(w?.url).toBe(a.url);
    expect(w?.init.headers).toEqual(a.init.headers);
    expect(w?.init.method).toBe(a.init.method);
    expect(w?.init.redirect).toBe(a.init.redirect);
    for (const bad of [undefined, "", "Mozilla/5.0 (X11)", "bad\nua", "x".repeat(201)]) {
      let appRefuses = false;
      try {
        validateUserAgent(bad);
      } catch {
        appRefuses = true;
      }
      expect(buildAsxRequest(bad, null) === null).toBe(appRefuses);
    }
  });
});

describe("Worker SQL on libsql", () => {
  it("grant, refusals and the 720 cap behave on the production engine", async () => {
    const f = pipelineFetch(main);
    expect(await acquire(WENV, T0, 1, f)).toEqual({ granted: false, reason: "disabled" });
    await enable();
    expect(await acquire(WENV, T0, 1, f)).toEqual({ granted: true, count: 1 });
    expect(await acquire(WENV, T0 + 64_900, 1, f)).toEqual({ granted: false, reason: "spacing" });
    expect(await acquire(WENV, T0 + 65_000, 3, f)).toEqual({ granted: true, count: 2 });
    await main.execute("UPDATE asx_rate_token SET day_count = 700, day_count_date = '2026-10-13'");
    expect(await acquire(WENV, T0 + 200_000, 3, f)).toEqual({ granted: false, reason: "reserved" });
    expect((await acquire(WENV, T0 + 200_000, 1, f)).granted).toBe(true);
  });

  it("trip and Retry-After work on libsql", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    expect(await mode()).toBe("tripped");
    expect(await acquire(WENV, T0 + 3_600_000, 1, f)).toEqual({
      granted: false,
      reason: "source_off",
    });
  });
});

describe("loadAsxTokenView (read-only)", () => {
  it("fresh database: off, nothing used, nothing tripped", async () => {
    const v = await loadAsxTokenView(main, NOW);
    expect(v).toMatchObject({
      enabled: false,
      sourceMode: "on",
      tripped: false,
      lastRequestAt: null,
      today: "2026-10-13",
      todayCount: 0,
      cap: 720,
      remainingToday: 720,
      nextAllowedAt: null,
      requestsLastHour: 0,
      blockedLastHour: 0,
    });
  });

  it("shows today's count, last request, a pending wait and the hourly tally", async () => {
    const f = pipelineFetch(main);
    await enable();
    await acquire(WENV, T0, 1, f);
    await recordOutcome(WENV, T0 + 1000, "blocked", f);
    await recordOutcome(WENV, T0 + 66_000, "rate_limited", f, { retryAfterS: 7200 });
    const v = await loadAsxTokenView(main, new Date(T0 + 120_000));
    expect(v).toMatchObject({
      enabled: true,
      todayCount: 1,
      remainingToday: 719,
      lastRequestAt: new Date(T0).toISOString(),
      requestsLastHour: 2,
      blockedLastHour: 1,
      nextAllowedAt: new Date(T0 + 66_000 + 3_600_000).toISOString(), // clamped to 3600 s
    });
    // an old count does not leak into a new Sydney day
    const next = await loadAsxTokenView(main, new Date(T0 + 24 * 3_600_000));
    expect(next).toMatchObject({ today: "2026-10-14", todayCount: 0, nextAllowedAt: null });
  });

  it("shows the trip with its reason and time", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    const v = await loadAsxTokenView(main, new Date(T0 + 700_000));
    expect(v.tripped).toBe(true);
    expect(v.sourceMode).toBe("tripped");
    expect(v.trippedSince).toBe(new Date(T0 + 9 * 65_000).toISOString());
    expect(v.trippedReason).toContain("asx_block_trip");
  });

  it("writes nothing", async () => {
    const before = await main.execute("SELECT COUNT(*) n FROM worker_state");
    await loadAsxTokenView(main, NOW);
    expect(await main.execute("SELECT COUNT(*) n FROM worker_state")).toEqual(before);
  });
});

describe("resetAsxTrip (Owner)", () => {
  const svc = (over: Record<string, unknown> = {}) =>
    resetAsxTrip({
      mainDb: main,
      authDb: auth,
      env: ENV,
      actorId: ownerId,
      now: NOW,
      ...over,
    } as Parameters<typeof resetAsxTrip>[0]);

  it("clears a trip: audit first, status on, outcome rows and wait removed, then works again", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    await recordOutcome(WENV, T0 + 700_000, "rate_limited", f, { retryAfterS: 600 });
    expect(await svc()).toEqual({ ok: true, reset: true });
    expect(await mode()).toBe("on");
    const st = (
      await main.execute(
        "SELECT reason, tripped_by FROM source_status WHERE source = 'asx_announcements'",
      )
    ).rows[0];
    expect(st.reason).toBeNull();
    expect(st.tripped_by).toBeNull();
    expect(
      Number(
        (
          await main.execute(
            "SELECT COUNT(*) n FROM worker_state WHERE key LIKE 'asxout:%' OR key = 'asx:next_allowed_at'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    expect(
      Number(
        (await main.execute("SELECT COUNT(*) n FROM worker_state WHERE key = 'asx_enabled'"))
          .rows[0].n,
      ),
    ).toBe(1);
    const a = await auditRows(auth);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: "asx.trip_reset",
      actor_user_id: ownerId,
      target_type: "source",
      target_id: "asx_announcements",
    });
    // the same hour's rows no longer trip it again; the Worker may ask for a token
    expect((await acquire(WENV, T0 + 3_600_000, 1, f)).granted).toBe(true);
    expect(await mode()).toBe("on");
  });

  it("is idempotent and writes nothing when the source is not tripped", async () => {
    expect(await svc()).toEqual({ ok: true, reset: false });
    expect(await auditRows(auth)).toHaveLength(0);
  });

  it("never touches an Owner-set off", async () => {
    await main.execute("UPDATE source_status SET mode = 'off' WHERE source = 'asx_announcements'");
    expect(await svc()).toEqual({ ok: true, reset: false });
    expect(await mode()).toBe("off");
  });

  it("refuses a non-Owner and an unknown actor; nothing changes", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    expect(await svc({ actorId: editorId })).toEqual({ ok: false, error: "forbidden" });
    expect(await svc({ actorId: 9999 })).toEqual({ ok: false, error: "forbidden" });
    expect(await mode()).toBe("tripped");
    expect(await auditRows(auth)).toHaveLength(0);
  });

  it("audit failure leaves the trip in place", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    expect(await svc({ env: {} })).toEqual({ ok: false, error: "unavailable" });
    expect(await mode()).toBe("tripped");
  });

  it("write failure rolls back and appends asx.trip_reset_failed", async () => {
    const f = pipelineFetch(main);
    await enable();
    await trip(f);
    await main.execute(
      "CREATE TRIGGER t_block BEFORE DELETE ON worker_state BEGIN SELECT RAISE(ABORT, 'no'); END",
    );
    expect(await svc()).toEqual({ ok: false, error: "unavailable" });
    expect(await mode()).toBe("tripped");
    expect((await auditRows(auth)).map((r) => r.action)).toEqual([
      "asx.trip_reset",
      "asx.trip_reset_failed",
    ]);
  });
});
