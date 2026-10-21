// @vitest-environment node
// AT-18 Sentinel cycle (M5 T15; NFR-002, PLT-070, PLT-075, AGT-010, DAT-122, ARN-020a; D-100, D-103).
// Verbatim: "Part A (production data-only): over 3 announcement-hour sessions each source meets NFR-002
// (ASX: >= 98% of scheduled 4-minute polls); ASX requests never closer than 65 s; Worker within CPU
// limit; new items stored once. Part B (staging, recorded items): a pending order whose pre-open
// re-check did not run by 10:00 fills flagged 'not re-checked'".
// Here: the real Worker poll (worker/src/asx/slots.ts) hands each changed feed body, signed, to the real
// sentinel-ingest handler over a real migrated database; the ASX and Turso calls are local fakes.
// Heavier cover: worker/test/{sentinel,asx,m5Slots}.test.ts (CPU budget, TST-124),
// tests/sentinel/*.test.ts, tests/arena/preopen*.test.ts.
// PENDING (Owner / production): Part A evidence over 3 real announcement-hour sessions after ASX is on
// (O-23, asx_enabled, ASX_LIVE, ASX_USER_AGENT, a recorded ASX feed fixture), Worker CPU from Cloudflare
// metrics, and the staging run of Part B.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAsx, type AsxEnv } from "../../../worker/src/asx/slots";
import { createSentinelIngestHandler } from "@/lib/sentinel/handler";
import { ingestFeed } from "@/lib/sentinel/ingest";
import type { NonceStore } from "@/lib/security/replay";
import { sydneyDate } from "@/lib/data/pipeline/rules.mjs";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { runPreopen } from "@/lib/arena/preopen";
import { localToUtc } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { MARKET, NOW, setMode, setupReplay } from "../../arena/replayHarness";

afterEach(() => {
  cleanupTempDbs();
  vi.restoreAllMocks();
});

// ---- Part A: Worker poll -> signed hand-off -> ingest ------------------------------------------------

const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const WENV: AsxEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: "libsql://x.turso.io",
  TURSO_MAIN_TOKEN: "t",
  ASX_LIVE: "1",
  ASX_USER_AGENT: "praxis-sentinel-test (contact: owner@example.test)",
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: SECRET,
};
const POLL = 4 * 60_000;
const SESSIONS = [
  Date.UTC(2026, 9, 12, 23, 0, 0), // Tue 13 Oct 10:00 AEDT
  Date.UTC(2026, 9, 13, 23, 0, 0), // Wed 14 Oct 10:00
  Date.UTC(2026, 9, 14, 23, 0, 0), // Thu 15 Oct 10:00
];
const POLLS_PER_SESSION = 20;

/** The Turso HTTP pipeline over a libsql client: the Worker's own SQL on the production engine. */
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

describe("AT-18 Part A: the Worker cycle (production data-only logic, local fakes)", () => {
  it("3 sessions of 4-minute polls: >= 98 % succeed, ASX requests >= 65 s apart (also under a burst), within the daily cap, every item stored once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = await freshDb("main");
    await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('asx_enabled', '\"1\"', 'x')",
    );
    const turso = pipelineFetch(db);

    let nowMs = SESSIONS[0]!;
    const asxCalls: number[] = [];
    let feedItems: object[] = [];
    let seq = 0;
    const nonces = new Set<string>();
    const store: NonceStore = {
      claim: async (n) => (nonces.has(n) ? false : (nonces.add(n), true)),
    };
    const handler = createSentinelIngestHandler({
      env: { WORKER_HMAC_SECRET: SECRET, BACKUP_PUBLIC_KEY: "age1xyz" },
      store,
      nowSec: () => Math.floor(nowMs / 1000),
      today: (s) => sydneyDate(s * 1000),
      ingest: (feed, h, today, nowSec) =>
        ingestFeed({ db, feed, sha: h, today, now: new Date(nowSec * 1000).toISOString() }),
    });
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://www.asx.com.au/")) {
        asxCalls.push(nowMs);
        return new Response(JSON.stringify({ data: feedItems }), {
          status: 200,
          headers: { "content-type": "application/json", etag: `"v${seq}"` },
        });
      }
      if (url.startsWith(APP)) return handler(new Request(url, init));
      return turso(input, init);
    }) as typeof fetch;

    const delivered: string[] = [];
    for (const session of SESSIONS) {
      for (let i = 0; i < POLLS_PER_SESSION; i++) {
        nowMs = session + i * POLL;
        if (i % 3 === 0) {
          seq++;
          // one new item per change; every earlier item is repeated in the feed (duplicates must be stored once)
          feedItems = [
            ...feedItems,
            {
              id: `r${seq}`,
              code: "ZZAA",
              time: new Date(nowMs - 5 * 60_000).toISOString(),
              type: "Progress Report",
              price_sensitive: false,
              title: `Synthetic update ${seq}`,
              url: "https://example.test/x.pdf",
            },
          ];
          delivered.push(`r${seq}`);
        }
        const s = await runAsx(WENV, nowMs, { fetch: f, nowMs: () => nowMs });
        expect(s.skipped).toBeNull();
      }
    }

    // NFR-002: ok + not_modified over scheduled, per session day
    const days = (
      await db.execute(
        "SELECT d, scheduled, ok, not_modified, failed, blocked FROM sentinel_poll_day ORDER BY d",
      )
    ).rows;
    expect(days).toHaveLength(3);
    for (const r of days) {
      expect(Number(r.scheduled)).toBe(POLLS_PER_SESSION);
      expect((Number(r.ok) + Number(r.not_modified)) / Number(r.scheduled)).toBeGreaterThanOrEqual(
        0.98,
      );
      expect(Number(r.failed) + Number(r.blocked)).toBe(0);
    }

    // DAT-122: no two ASX requests closer than 65 s; a burst retry 30 s later is refused by the token
    for (let i = 1; i < asxCalls.length; i++) {
      expect(asxCalls[i]! - asxCalls[i - 1]!).toBeGreaterThanOrEqual(65_000);
    }
    const before = asxCalls.length;
    nowMs = SESSIONS[2]! + POLLS_PER_SESSION * POLL;
    await runAsx(WENV, nowMs, { fetch: f, nowMs: () => nowMs });
    const burstAt = nowMs + 30_000;
    nowMs = burstAt;
    await runAsx(WENV, SESSIONS[2]! + POLLS_PER_SESSION * POLL, { fetch: f, nowMs: () => burstAt });
    expect(asxCalls.length).toBe(before + 1); // the second attempt, 30 s later, made no ASX request
    const tok = (await db.execute("SELECT day_count FROM asx_rate_token")).rows[0]!;
    expect(Number(tok.day_count)).toBeLessThanOrEqual(720); // DAT-122 daily cap

    // new items stored once (UNIQUE + count check)
    const stored = (
      await db.execute(
        "SELECT ann_id, COUNT(*) AS n FROM announcement GROUP BY market, source, ann_id",
      )
    ).rows;
    expect(stored).toHaveLength(delivered.length); // the feed repeats earlier items many times; each is stored once
    expect(stored.every((r) => Number(r.n) === 1)).toBe(true);
    // the Worker hands off only a CHANGED body: one ingest per feed change
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM sentinel_ingest")).rows[0]!.n)).toBe(
      delivered.length,
    );
  });
});

// ---- Part B: pre-open re-check (staging logic on recorded/synthetic items) ---------------------------

const BASE = { startD: "2030-01-07", sessions: 30, seed: 3 };
const TZ = "Australia/Sydney";
const at = (d: string, hm: string): string => localToUtc(d, hm, TZ).toISOString();
const rowsOf = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows;

async function prep() {
  const s = await setupReplay({ ...BASE, keep: ["E01"] });
  await setMode(s.db, "full");
  const cohort = s.cohortIds.find((id) => id.startsWith("E01@")) as string;
  const order = (id: string, code = "ZZA") =>
    s.db.execute({
      sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
            VALUES (?, ?, ?, ?, 'buy', 'entry', 30, 500000, 'U1')`,
      args: [id, cohort, s.ds.dates[1], code],
    });
  return { ...s, prior: s.ds.dates[1], d: s.ds.dates[2], order };
}

describe("AT-18 Part B: pre-open re-check (ARN-020a)", () => {
  it("a pending order whose re-check did not run by the open fills flagged 'not re-checked' and raises a P1", async () => {
    const s = await prep();
    await s.order("O1");
    await closeBooksDay(s.db, { market: MARKET, d: s.d, replay: true, now: NOW });
    expect((await rowsOf(s.db, "SELECT status FROM arena_order WHERE id = 'O1'"))[0]!.status).toBe(
      "filled",
    );
    expect(
      (await rowsOf(s.db, "SELECT outcome FROM preopen_result WHERE order_id = 'O1'"))[0]!.outcome,
    ).toBe("not_rechecked");
    expect((await rowsOf(s.db, "SELECT status FROM preopen_run"))[0]!.status).toBe("not_run");
    expect(
      (await rowsOf(s.db, "SELECT tier FROM alert WHERE alert_key = ?", [`preopen:AU:${s.d}`]))[0]!
        .tier,
    ).toBe("P1");
  });

  it("a failing re-check cancels the order with the reason stored; an item the decision already knew does not", async () => {
    const s = await prep();
    await s.order("O1", "ZZA");
    await s.order("O2", "ZZB");
    const ann = (id: string, code: string, t: string) =>
      s.db.execute({
        sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source)
              VALUES ('AU', ?, ?, ?, ?, 'Trading Halt', 0, 'Trading halt', NULL, 'asx_announcements')`,
        args: [code, id, t, t],
      });
    await ann("h1", "ZZA", at(s.d, "09:30"));
    await ann("h2", "ZZB", at(s.prior, "10:00"));
    expect(await runPreopen(s.db, { market: MARKET, d: s.d, attempt: 1, now: NOW })).toMatchObject({
      status: "ok",
      cancelled: 1,
    });
    expect(
      (await rowsOf(s.db, "SELECT status, reject_reason FROM arena_order WHERE id = 'O1'"))[0],
    ).toMatchObject({ status: "cancelled", reject_reason: "preopen:halt" });
    expect(
      (await rowsOf(s.db, "SELECT outcome, reason FROM preopen_result WHERE order_id = 'O1'"))[0],
    ).toMatchObject({ outcome: "cancel", reason: "halt" });
    expect((await rowsOf(s.db, "SELECT status FROM arena_order WHERE id = 'O2'"))[0]!.status).toBe(
      "pending",
    );
  });

  it("a rerun is a no-op (the 09:58 retry after a success does nothing)", async () => {
    const s = await prep();
    await s.order("O1");
    await runPreopen(s.db, { market: MARKET, d: s.d, attempt: 1, now: NOW });
    expect(
      await runPreopen(s.db, { market: MARKET, d: s.d, attempt: 2, now: NOW }),
    ).not.toMatchObject({
      status: "error",
    });
    expect(await rowsOf(s.db, "SELECT 1 FROM preopen_result")).toHaveLength(1);
  });
});
