// @vitest-environment node
// AT-21 Kill switch (M5 T15; DAT-123, OPS-036). Verbatim: "Turning the ASX source off stops requests
// within one cycle; review lists it". The switch is turned off through the real Owner control (audit
// first); the next Worker tick makes no ASX request; the Evening Review section 9 lists "ASX feed" off.
// Heavier cover: worker/test/asx.test.ts ("asx_enabled off"), tests/data/controls.test.ts,
// tests/review/sections.test.ts ("section 9").
// PENDING (production): the run with the real ASX feed, together with AT-18 Part A (needs O-23,
// asx_enabled, ASX_LIVE, ASX_USER_AGENT).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAsxEnabled } from "@/lib/data/controls";
import { buildFacts } from "@/lib/review/assemble";
import { runAsx, type AsxEnv } from "../../../worker/src/asx/slots";
import { addUser, auditRows, KEY } from "../../auth/helpers";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(() => {
  cleanupTempDbs();
  vi.restoreAllMocks();
});

const WENV: AsxEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: "libsql://x.turso.io",
  TURSO_MAIN_TOKEN: "t",
  ASX_LIVE: "1",
  ASX_USER_AGENT: "praxis-sentinel-test (contact: owner@example.test)",
  APP_BASE_URL: "https://praxis-app.example.test",
  WORKER_HMAC_SECRET: "7".repeat(64),
};
const T0 = Date.UTC(2026, 9, 12, 23, 0, 0); // Tue 13 Oct 10:00 AEDT, a poll minute
const POLL = 4 * 60_000;

function pipelineFetch(db: Client): typeof fetch {
  return (async (_u: string | URL | Request, init?: RequestInit) => {
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

describe("AT-21 kill switch", () => {
  it("switching ASX off stops requests on the next tick, is audited, and the review section 9 lists it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const main = await freshDb("main");
    const auth = await freshDb("auth");
    const ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
    await main.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
    // ON stands in for the Owner prerequisites (O-23 accepted, asx_enabled set); here only OFF is exercised.
    await main.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('asx_enabled', '\"1\"', 'x')",
    );
    const turso = pipelineFetch(main);
    const asxCalls: number[] = [];
    let now = T0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith("https://www.asx.com.au/")) {
        asxCalls.push(now);
        return new Response('{"data":[]}', {
          status: 200,
          headers: { "content-type": "application/json", etag: '"v1"' },
        });
      }
      if (String(input).startsWith("https://praxis-app.example.test/")) {
        return Response.json({ result: "ingested" });
      }
      return turso(input, init);
    }) as typeof fetch;
    const tick = () => runAsx(WENV, now, { fetch: f, nowMs: () => now });
    const facts = async () =>
      (
        await buildFacts(main, {
          market: "AU",
          d: "2026-10-13",
          env: "production",
          appUrl: "https://praxis.example.test",
          now: new Date(now),
        })
      ).facts.health.find((h) => h.label === "ASX feed");

    // switch on: the poll makes its one request and the review says the feed is on
    expect((await tick()).fetched).toBe(1);
    expect(asxCalls).toHaveLength(1);
    expect(await facts()).toMatchObject({ status: "ok" });

    // the Owner turns it off through the real control (audit first)
    now = T0 + 60_000;
    const r = await setAsxEnabled({
      mainDb: main,
      authDb: auth,
      env: { PII_HASH_KEY: KEY } as never,
      actorId: ownerId,
      now: new Date(now),
      enabled: false,
    });
    expect(r).toEqual({ ok: true, changed: true });
    expect((await auditRows(auth)).filter((a) => a.action === "controls.asx_enabled")).toHaveLength(
      1,
    );

    // within one cycle: the next 4-minute tick makes no ASX request
    now = T0 + POLL;
    expect(await tick()).toMatchObject({ skipped: "disabled", fetched: 0 });
    now = T0 + 2 * POLL;
    expect(await tick()).toMatchObject({ skipped: "disabled", fetched: 0 });
    expect(asxCalls).toHaveLength(1);

    // the review lists it
    const line = await facts();
    expect(line).toMatchObject({ status: "attention" });
    expect(line?.detail).toContain("off");
  });
});
