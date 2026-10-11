// @vitest-environment node
// PLT-074, AT-05: GET /api/cron/heartbeat-morning and /api/cron/heartbeat-evening.
// Auth, production only, idempotent per Melbourne date, S2 incident raise and no-raise.
// No network, no real secrets.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as evening from "@/app/api/cron/heartbeat-evening/route";
import * as morning from "@/app/api/cron/heartbeat-morning/route";
import { createHeartbeatHandler } from "@/lib/heartbeat/handler";
import { listOpenS2 } from "@/lib/heartbeat/incidents";
import type { HeartbeatKind } from "@/lib/heartbeat/state";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const CRON = "c".repeat(32);
const PROD = { CRON_SECRET: CRON, BACKUP_PUBLIC_KEY: "age1fake" };
const MORNING_NOW = new Date("2026-10-12T00:30:00.000Z"); // Monday 11:30 Melbourne (AEDT)
const EVENING_NOW = new Date("2026-10-12T11:10:00.000Z"); // Monday 22:10 Melbourne

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const make = (
  kind: HeartbeatKind,
  now = kind === "morning" ? MORNING_NOW : EVENING_NOW,
  env: Record<string, string | undefined> = PROD,
  mainDb: () => Client = () => db,
) => createHeartbeatHandler(kind, { env, mainDb, now: () => now });
const get = (path: string, auth: string | null = `Bearer ${CRON}`) =>
  new Request(`https://praxis-host.vercel.app${path}`, {
    method: "GET",
    headers: auth === null ? {} : { Authorization: auth },
  });
const MP = "/api/cron/heartbeat-morning";
const EP = "/api/cron/heartbeat-evening";
const rows = async (sql: string) => (await db.execute(sql)).rows;
const runs = (job?: string) =>
  rows(`SELECT * FROM run_record WHERE job LIKE '${job ?? "heartbeat-%"}' ORDER BY id`);
const incidents = () => rows("SELECT * FROM incident ORDER BY id");

async function healthyMorning() {
  await db.execute(
    `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
     VALUES ('worker-clock', 'AU', 'worker-clock:AU:2026-10-12', '2026-10-12T00:00:00.000Z', 'success')`,
  );
}

describe("route modules", () => {
  it("export GET only", () => {
    for (const route of [morning, evening]) {
      expect(typeof route.GET).toBe("function");
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(m in route).toBe(false);
    }
  });
});

describe.each([
  ["morning", MP],
  ["evening", EP],
] as const)("%s authentication", (kind, path) => {
  it.each([
    ["missing header", null],
    ["empty bearer", "Bearer "],
    ["wrong secret", `Bearer ${"d".repeat(32)}`],
    ["wrong scheme", `Basic ${CRON}`],
    ["lowercase scheme", `bearer ${CRON}`],
    ["prefix of the secret", `Bearer ${CRON.slice(0, 31)}`],
    ["longer than the secret", `Bearer ${CRON}x`],
  ])("401 generic, nothing written: %s", async (_n, auth) => {
    const res = await make(kind)(get(path, auth));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await runs()).toHaveLength(0);
  });

  it.each([undefined, "", "   ", "short", "x".repeat(15)])(
    "503 generic when CRON_SECRET is %j, even for a matching header",
    async (secret) => {
      const res = await make(kind, undefined, { ...PROD, CRON_SECRET: secret })(
        get(path, `Bearer ${secret ?? ""}`),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
      expect(await runs()).toHaveLength(0);
    },
  );

  it("the secret never appears in a response", async () => {
    for (const auth of [null, `Bearer ${CRON}`, "Bearer nope"]) {
      expect(await (await make(kind)(get(path, auth))).text()).not.toContain(CRON);
    }
  });
});

describe.each([
  ["morning", MP],
  ["evening", EP],
] as const)("%s: production only (PLT-074)", (kind, path) => {
  it.each([
    ["staging (test identity secret, no backup key)", { TEST_IDENTITY_SECRET: "t".repeat(64) }],
    ["neither signal", {}],
    ["both signals", { BACKUP_PUBLIC_KEY: "age1fake", TEST_IDENTITY_SECRET: "t".repeat(64) }],
  ])("200 no-op, no run record, no incident: %s", async (_n, extra) => {
    const res = await make(kind, undefined, { CRON_SECRET: CRON, ...extra })(get(path));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not production" });
    expect(await runs()).toHaveLength(0);
    expect(await incidents()).toHaveLength(0);
  });

  it("a bad bearer on staging is still 401 (auth comes first)", async () => {
    const res = await make(kind, undefined, { CRON_SECRET: CRON })(get(path, "Bearer nope"));
    expect(res.status).toBe(401);
  });
});

describe("morning behaviour", () => {
  it("healthy Worker: success run record, no incident", async () => {
    await healthyMorning();
    const res = await make("morning")(get(MP));
    expect(await res.json()).toEqual({ status: "ok", date: "2026-10-12" });
    const r = await runs();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      job: "heartbeat-morning",
      market: "AU",
      status: "success",
      concurrency_key: "heartbeat-morning:2026-10-12",
      scheduled_for: "2026-10-12",
      items_processed: 1,
      error_summary: null,
    });
    expect(JSON.parse(String(r[0].details_json))).toMatchObject({
      status: "ok",
      final: true,
      problems: [],
    });
    expect(await incidents()).toHaveLength(0);
  });

  it("Worker stopped (AT-05): opens one S2 incident and records a failed run", async () => {
    const res = await make("morning")(get(MP));
    expect(await res.json()).toEqual({ status: "problems", date: "2026-10-12" });
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ severity: "S2", kind: "worker_blind", resolved_at: null });
    expect(JSON.parse(String(inc[0].detail_json))).toEqual({
      check: "morning",
      date: "2026-10-12",
    });
    const r = await runs();
    expect(r[0]).toMatchObject({ status: "failed" });
    expect(String(r[0].error_summary)).toMatch(/Worker has not reported/);
    expect(JSON.parse(String(r[0].details_json))).toMatchObject({
      status: "problems",
      problems: ["worker_blind"],
      opened: ["worker_blind"],
      final: true,
    });
    expect((await listOpenS2(db)).map((i) => i.kind)).toEqual(["worker_blind"]);
  });

  it("is idempotent per Melbourne date: a second call changes nothing", async () => {
    const h = make("morning");
    await h(get(MP));
    const res = await h(get(MP));
    expect(await res.json()).toEqual({ skipped: "already ran", date: "2026-10-12" });
    expect(await runs()).toHaveLength(1);
    expect(await incidents()).toHaveLength(1);
  });

  it("the next day runs again; an open incident of the same kind is not duplicated", async () => {
    await make("morning")(get(MP));
    const next = new Date("2026-10-13T00:30:00.000Z");
    const res = await make("morning", next)(get(MP));
    expect(await res.json()).toEqual({ status: "problems", date: "2026-10-13" });
    expect(await runs()).toHaveLength(2);
    expect(await incidents()).toHaveLength(1);
    const d = JSON.parse(String((await runs())[1].details_json));
    expect(d.opened).toEqual([]);
    expect(d.problems).toEqual(["worker_blind"]);
  });

  it("a resolved incident starts a new episode", async () => {
    await make("morning")(get(MP));
    await db.execute("UPDATE incident SET resolved_at = '2026-10-12T05:00:00.000Z'");
    await make("morning", new Date("2026-10-13T00:30:00.000Z"))(get(MP));
    expect(await incidents()).toHaveLength(2);
  });

  it("Melbourne date key: UTC evening is already the next Melbourne day", async () => {
    // 2026-10-11T13:30Z is 00:30 on 12 October in Melbourne.
    const res = await make("morning", new Date("2026-10-11T13:30:00.000Z"))(get(MP));
    expect((await res.json()).date).toBe("2026-10-12");
  });

  it("a stale ASX poll in announcement hours opens sentinel_blind (S2)", async () => {
    await healthyMorning();
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('asx_enabled', '\"1\"', 'x')",
    );
    await db.execute(
      "UPDATE asx_rate_token SET last_request_at = '2026-10-12T00:00:00.000Z' WHERE id = 1",
    );
    await make("morning")(get(MP));
    expect((await incidents()).map((i) => [i.severity, i.kind])).toEqual([
      ["S2", "sentinel_blind"],
    ]);
  });
});

describe("evening behaviour", () => {
  it("writes its own run record and checks the marker on a trading day", async () => {
    await db.execute(
      `INSERT INTO run_record (job, market, concurrency_key, started_at, status)
       VALUES ('worker-clock', 'AU', 'worker-clock:AU:2026-10-12', '2026-10-12T00:00:00.000Z', 'success')`,
    );
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
    );
    await make("evening")(get(EP));
    expect((await incidents()).map((i) => [i.severity, i.kind])).toEqual([
      ["S2", "completion_marker_missing"],
    ]);
    const r = await runs("heartbeat-evening");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      status: "failed",
      concurrency_key: "heartbeat-evening:2026-10-12",
    });
    expect(await runs("heartbeat-morning")).toHaveLength(0);
  });

  it("with the marker present it is a success; evening and morning keys do not collide", async () => {
    await healthyMorning();
    await db.execute(
      "INSERT INTO completion_marker (market, d, kind, at, outcome) VALUES ('AU', '2026-10-12', 'data', 'x', 'ok')",
    );
    await db.execute(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES ('dispatch_enabled', '\"1\"', 'x')",
    );
    await make("morning")(get(MP));
    await make("evening")(get(EP));
    const r = await runs();
    expect(r.map((x) => [x.job, x.status])).toEqual([
      ["heartbeat-morning", "success"],
      ["heartbeat-evening", "success"],
    ]);
    expect(await incidents()).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("an unreadable database during the checks is 'unknown', recorded failed and retryable", async () => {
    await db.execute("DROP TABLE market");
    const bad = await make("evening")(get(EP));
    expect(await bad.json()).toEqual({ status: "unknown", date: "2026-10-12" });
    let r = await runs();
    expect(r[0]).toMatchObject({ status: "failed" });
    expect(String(r[0].error_summary)).toBe("Check could not read the database.");
    expect(JSON.parse(String(r[0].details_json)).final).toBe(false);
    expect(await incidents()).toHaveLength(0);
    // The same day can be retried (final is false), and a later success is the record.
    const again = await make("evening")(get(EP));
    expect(((await again.json()) as { skipped?: string }).skipped).toBeUndefined();
    r = await runs();
    expect(r).toHaveLength(2);
  });

  it("an incident that cannot be written leaves the check retryable", async () => {
    await db.execute("DROP TABLE incident");
    const res = await make("morning")(get(MP));
    expect(await res.json()).toEqual({ status: "problems", date: "2026-10-12" });
    const d = JSON.parse(String((await runs())[0].details_json));
    expect(d).toMatchObject({ incidentWriteFailed: true, final: false });
    const again = await make("morning")(get(MP));
    expect(((await again.json()) as { skipped?: string }).skipped).toBeUndefined();
  });

  it("any other error is a generic 503 with no detail", async () => {
    const res = await make("morning", undefined, PROD, () => {
      throw new Error("secret connection string");
    })(get(MP));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('{"error":"unavailable"}');
  });
});
