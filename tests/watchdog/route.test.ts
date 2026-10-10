// @vitest-environment node
// PLT-074, SEC-108 d, AT-05b: GET /api/cron/watchdog. No network, no real secrets.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as route from "@/app/api/cron/watchdog/route";
import { bearerMatches, createWatchdogHandler, melbourneDate } from "@/lib/watchdog/handler";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { A, B, githubMock, TOKEN } from "./helpers";

afterEach(cleanupTempDbs);

const CRON = "c".repeat(32);
const PROD = {
  CRON_SECRET: CRON,
  BACKUP_PUBLIC_KEY: "age1fake",
  GITHUB_READ_TOKEN: TOKEN,
  APP_COMMIT: A,
};
const NOW = new Date("2026-10-10T11:40:00.000Z"); // 22:40 on 2026-10-10 in Melbourne (AEDT)

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const approved = (sha: string) => githubMock([{ id: 1, sha, state: "success" }]);
const make = (over: Record<string, unknown> = {}, env: Record<string, string | undefined> = PROD) =>
  createWatchdogHandler({
    env,
    fetchImpl: approved(A).fetchImpl,
    mainDb: () => db,
    now: () => NOW,
    ...over,
  });
const get = (auth: string | null = `Bearer ${CRON}`) =>
  new Request("https://praxis-host.vercel.app/api/cron/watchdog", {
    method: "GET",
    headers: auth === null ? {} : { Authorization: auth },
  });
const rows = async (sql: string) => (await db.execute(sql)).rows;
const runCount = async () => rows("SELECT * FROM run_record").then((r) => r.length);
const incidents = () => rows("SELECT * FROM incident");

describe("route module", () => {
  it("exports GET only", () => {
    expect(typeof route.GET).toBe("function");
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(m in route).toBe(false);
  });
});

describe("authentication", () => {
  it.each([
    ["missing header", null],
    ["empty bearer", "Bearer "],
    ["wrong secret", `Bearer ${"d".repeat(32)}`],
    ["wrong scheme", `Basic ${CRON}`],
    ["no scheme", CRON],
    ["lowercase scheme", `bearer ${CRON}`],
    ["shorter prefix of the secret", `Bearer ${CRON.slice(0, 31)}`],
    ["longer than the secret", `Bearer ${CRON}x`],
  ])("401 generic, nothing written: %s", async (_n, auth) => {
    const res = await make()(get(auth));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await runCount()).toBe(0);
  });

  it.each([undefined, "", "   ", "short", "x".repeat(15)])(
    "503 generic when CRON_SECRET is %j, even for a matching header",
    async (secret) => {
      const env = { ...PROD, CRON_SECRET: secret };
      const res = await make({}, env)(get(`Bearer ${secret ?? ""}`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(await runCount()).toBe(0);
    },
  );

  it("compares fixed-size digests, so any header length is handled without an early exit", () => {
    expect(bearerMatches(`Bearer ${CRON}`, CRON)).toBe(true);
    expect(bearerMatches("Bearer x", CRON)).toBe(false);
    expect(bearerMatches("", CRON)).toBe(false);
    expect(bearerMatches(null, CRON)).toBe(false);
    expect(bearerMatches("B".repeat(10_000), CRON)).toBe(false);
  });

  it("the secret never appears in a response", async () => {
    for (const auth of [null, `Bearer ${CRON}`, "Bearer nope"]) {
      const res = await make()(get(auth));
      expect(await res.text()).not.toContain(CRON);
    }
  });
});

describe("production only", () => {
  it.each([
    ["staging (test identity secret, no backup key)", { TEST_IDENTITY_SECRET: "t".repeat(64) }],
    ["neither signal", {}],
    [
      "both signals (ambiguous)",
      { BACKUP_PUBLIC_KEY: "age1fake", TEST_IDENTITY_SECRET: "t".repeat(64) },
    ],
  ])("200 no-op, no run, no incident, no GitHub call: %s", async (_n, extra) => {
    const gh = approved(B);
    const env: Record<string, string | undefined> = {
      CRON_SECRET: CRON,
      GITHUB_READ_TOKEN: TOKEN,
      APP_COMMIT: A,
      ...extra,
    };
    const res = await make({ fetchImpl: gh.fetchImpl }, env)(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not production" });
    expect(await runCount()).toBe(0);
    expect(await incidents()).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it("a bad bearer on staging is still 401 (auth comes first)", async () => {
    const res = await make(
      {},
      { CRON_SECRET: CRON, TEST_IDENTITY_SECRET: "t".repeat(64) },
    )(get("Bearer nope"));
    expect(res.status).toBe(401);
  });
});

describe("run record and outcomes", () => {
  it("ok: success run record with status and shas, no incident", async () => {
    const res = await make()(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", date: "2026-10-10" });
    const r = (await rows("SELECT * FROM run_record"))[0];
    expect(r).toMatchObject({
      job: "watchdog-approved-commit",
      concurrency_key: "watchdog:2026-10-10",
      scheduled_for: "2026-10-10",
      status: "success",
      commit_sha: A,
    });
    expect(JSON.parse(String(r.details_json))).toMatchObject({
      status: "ok",
      approvedSha: A,
      deployedSha: A,
    });
    expect(await incidents()).toHaveLength(0);
  });

  it("awaiting first approval: success run, no incident", async () => {
    const res = await make({ fetchImpl: githubMock([]).fetchImpl })(get());
    expect(await res.json()).toEqual({ status: "awaiting_first_approval", date: "2026-10-10" });
    const r = (await rows("SELECT * FROM run_record"))[0];
    expect(r.status).toBe("success");
    expect(JSON.parse(String(r.details_json)).status).toBe("awaiting_first_approval");
    expect(await incidents()).toHaveLength(0);
  });

  it("mismatch: failed run record and ONE open S1 unapproved_production_code incident", async () => {
    const res = await make({ fetchImpl: approved(B).fetchImpl })(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "mismatch", date: "2026-10-10" });
    const r = (await rows("SELECT * FROM run_record"))[0];
    expect(r.status).toBe("failed");
    expect(JSON.parse(String(r.details_json))).toMatchObject({
      status: "mismatch",
      approvedSha: B,
      deployedSha: A,
      incident: "opened",
      final: true,
    });
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({
      severity: "S1",
      kind: "unapproved_production_code",
      resolved_at: null,
      at: NOW.toISOString(),
    });
    expect(JSON.parse(String(inc[0].detail_json))).toMatchObject({
      approvedSha: B,
      deployedSha: A,
    });
  });

  it("a mismatch on a later day does not duplicate an open incident", async () => {
    await make({ fetchImpl: approved(B).fetchImpl })(get());
    const next = new Date("2026-10-11T11:40:00.000Z");
    await make({ fetchImpl: approved(B).fetchImpl, now: () => next })(get());
    expect(await runCount()).toBe(2);
    expect(await incidents()).toHaveLength(1);
    // Once resolved, a new mismatch opens a new one.
    await db.execute("UPDATE incident SET resolved_at = 'x'");
    const later = new Date("2026-10-12T11:40:00.000Z");
    await make({ fetchImpl: approved(B).fetchImpl, now: () => later })(get());
    expect(await incidents()).toHaveLength(2);
  });

  it.each([
    ["GitHub 403", () => githubMock([], 403).fetchImpl, PROD],
    ["GitHub 503", () => githubMock([], 503).fetchImpl, PROD],
    ["no token", () => approved(A).fetchImpl, { ...PROD, GITHUB_READ_TOKEN: undefined }],
    ["no APP_COMMIT", () => approved(A).fetchImpl, { ...PROD, APP_COMMIT: undefined }],
  ])("unknown (%s): failed run, no incident, never ok", async (_n, f, env) => {
    const res = await make({ fetchImpl: f() }, env)(get());
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("unknown");
    const r = (await rows("SELECT * FROM run_record"))[0];
    expect(r.status).toBe("failed");
    expect(JSON.parse(String(r.details_json)).status).toBe("unknown");
    expect(await incidents()).toHaveLength(0);
  });

  it("the token never reaches the run record, incident, response or error summary", async () => {
    const throwing = (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as unknown as typeof fetch;
    const res = await make({ fetchImpl: throwing })(get());
    await make({
      fetchImpl: approved(B).fetchImpl,
      now: () => new Date(NOW.getTime() + 86_400_000),
    })(get());
    expect(await res.text()).not.toContain(TOKEN);
    const dump = JSON.stringify([
      ...(await rows("SELECT * FROM run_record")),
      ...(await incidents()),
    ]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(CRON);
  });

  it("calls GitHub with a timeout signal", async () => {
    const seen: unknown[] = [];
    const inner = approved(A).fetchImpl;
    const spy = (async (u: string, init: { signal?: unknown }) => {
      seen.push(init.signal);
      return (inner as unknown as (u: string, i: unknown) => Promise<Response>)(u, init);
    }) as unknown as typeof fetch;
    await make({ fetchImpl: spy })(get());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("503 generic when the database fails", async () => {
    const broken = {
      execute: async () => {
        throw new Error("down");
      },
    } as unknown as Client;
    const res = await make({ mainDb: () => broken })(get());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });
});

describe("idempotency per Melbourne date", () => {
  it("a second call the same date is skipped and writes nothing", async () => {
    await make()(get());
    const gh = approved(A);
    const res = await make({ fetchImpl: gh.fetchImpl })(get());
    expect(await res.json()).toEqual({ skipped: "already ran", date: "2026-10-10" });
    expect(await runCount()).toBe(1);
    expect(gh.calls).toHaveLength(0);
  });

  it("a completed mismatch day is also not repeated", async () => {
    await make({ fetchImpl: approved(B).fetchImpl })(get());
    const res = await make({ fetchImpl: approved(B).fetchImpl })(get());
    expect((await res.json()).skipped).toBe("already ran");
    expect(await runCount()).toBe(1);
    expect(await incidents()).toHaveLength(1);
  });

  it("an unknown result stays retryable the same day", async () => {
    await make({ fetchImpl: githubMock([], 503).fetchImpl })(get());
    const res = await make()(get());
    expect((await res.json()).status).toBe("ok");
    expect(await runCount()).toBe(2);
  });

  it("the date is the Melbourne date, not the UTC date", async () => {
    expect(melbourneDate(new Date("2026-10-10T13:30:00Z"))).toBe("2026-10-11"); // 00:30 AEDT
    expect(melbourneDate(new Date("2026-10-10T11:40:00Z"))).toBe("2026-10-10");
    expect(melbourneDate(new Date("2026-07-10T14:30:00Z"))).toBe("2026-07-11"); // AEST
    await make({ now: () => new Date("2026-10-10T13:30:00Z") })(get());
    const next = await make({ now: () => new Date("2026-10-10T11:40:00Z") })(get());
    expect((await next.json()).status).toBe("ok"); // different Melbourne date: runs
  });
});
