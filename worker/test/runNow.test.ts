// "Run now" in the Worker (D-840..D-849): pending requests are picked up on the per-minute tick, run
// through the SAME dispatch path as the schedule (workflow dispatch / signed route POST), refused by the
// schedule's own safety gates (kill switch, Owner list, market mode, trading day, route condition,
// workflow inputs), expired after 30 minutes, and never run twice. Real SQLite behind the Turso fake;
// nothing touches a network.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PER_TICK,
  RUN_NOW_EXPIRY_MS,
  planRequest,
  runRunNow,
  type RunNowEnv,
} from "../src/runNow";
import { AU_SLOTS } from "../src/schedule";
import { TOKEN, TURSO_TOKEN, TURSO_URL, makeDb, makeNet, rows, type Net } from "./fakeTurso";

const SECRET = "7".repeat(64);
const APP = "https://praxis-app.example.test";
const ENV: RunNowEnv = {
  PRAXIS_ENV: "production",
  TURSO_MAIN_URL: TURSO_URL,
  TURSO_MAIN_TOKEN: TURSO_TOKEN,
  GITHUB_DISPATCH_TOKEN: TOKEN,
  APP_BASE_URL: APP,
  WORKER_HMAC_SECRET: SECRET,
};
const MIN = 60_000;
/** Mon 19 Oct 2026 03:00 Sydney (AEDT, +11): no slot is in its window. */
const T0 = Date.UTC(2026, 9, 18, 16, 0);
/** Sat 17 Oct 2026 03:00 Sydney. */
const SAT = Date.UTC(2026, 9, 16, 16, 0);
const iso = (ms: number) => new Date(ms).toISOString();

let db: DatabaseSync;
let net: Net;
let f: typeof fetch;
let appCalls: { slot: string; d: string }[];
let appStatus: number;

const setState = (key: string, v: string) =>
  db
    .prepare(
      "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x') " +
        "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    )
    .run(key, v);
const dispatchOn = () => setState("dispatch_enabled", '"1"');
const list = (ids: string[]) => setState("slots_enabled", JSON.stringify(ids));
const marketMode = (mode: string) =>
  db.prepare("UPDATE market SET mode = ? WHERE code = 'AU'").run(mode);
const add = (jobId: string, params = "{}", at = T0 - MIN) =>
  Number(
    (
      db
        .prepare(
          "INSERT INTO run_now_request (job_id, market, params_json, requested_by_hmac, requested_at, " +
            "audit_ref, status, updated_at) VALUES (?, 'AU', ?, ?, ?, 'audit:1', 'pending', ?)",
        )
        .run(jobId, params, "a".repeat(64), iso(at), iso(at)) as unknown as {
        lastInsertRowid: number | bigint;
      }
    ).lastInsertRowid,
  );
const req = (id: number) =>
  rows(db, "SELECT status, result FROM run_now_request WHERE id = ?", id)[0] as {
    status: string;
    result: string | null;
  };
const tick = (t = T0, env: RunNowEnv = ENV) => runRunNow(env, t, { fetch: f, nowMs: () => t });
const githubWorkflows = () =>
  net.github.map((c) => /workflows\/([^/]+)\/dispatches/.exec(c.url)![1]);

beforeEach(() => {
  db = makeDb({ sentinel: false });
  net = makeNet(db);
  appCalls = [];
  appStatus = 200;
  f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(APP)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      appCalls.push({ slot: String(body.slot), d: String(body.d) });
      return Response.json({ ok: true }, { status: appStatus });
    }
    return net.f(input, init);
  }) as typeof fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("idle and pickup", () => {
  it("an idle minute makes ONE database request and nothing else", async () => {
    const s = await tick();
    expect(net.pipelines).toBe(1);
    expect(s).toEqual({ requests: 1, started: [], refused: [] });
    expect(net.github).toEqual([]);
    expect(appCalls).toEqual([]);
  });

  it("does nothing without a database or for an unknown environment", async () => {
    await tick(T0, { ...ENV, TURSO_MAIN_URL: undefined });
    await tick(T0, { ...ENV, PRAXIS_ENV: "dev" });
    expect(net.pipelines).toBe(0);
  });

  it("starts a listed workflow job outside its time window, through the schedule's dispatch path", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices");
    const s = await tick();
    expect(githubWorkflows()).toEqual(["backfill-prices.yml"]);
    expect(JSON.parse(net.github[0]!.body)).toEqual({ ref: "release" });
    expect(req(id)).toEqual({ status: "done", result: "started: HTTP 204" });
    expect(s.started).toEqual(["backfill-prices"]);
  });

  it("starts a route job with a signed POST carrying the chosen date", async () => {
    dispatchOn();
    list(["evening-review"]);
    const id = add("evening-review", '{"d":"2026-10-18"}');
    await tick();
    expect(appCalls).toEqual([{ slot: "evening-review", d: "2026-10-18" }]);
    expect(req(id)).toEqual({ status: "done", result: "ran: HTTP 200" });
  });

  it("a route job without a date runs for the Sydney date of the tick", async () => {
    dispatchOn();
    list(["morning"]);
    add("morning");
    await tick();
    expect(appCalls).toEqual([{ slot: "morning", d: "2026-10-19" }]);
  });

  it("a job that fails is recorded as done with the failure word", async () => {
    dispatchOn();
    list(["evening-review"]);
    appStatus = 500;
    const id = add("evening-review");
    await tick();
    expect(req(id)).toEqual({ status: "done", result: "failed: HTTP 500" });
    net.githubPlan.push(422);
    list(["backfill-prices"]);
    const id2 = add("backfill-prices");
    await tick();
    expect(req(id2)).toEqual({ status: "done", result: "failed: HTTP 422" });
  });

  it("runs at most MAX_PER_TICK requests per tick, oldest first; the rest wait for the next tick", async () => {
    dispatchOn();
    list(["backfill-prices", "backfill-history", "kb-archive", "replay"]);
    const ids = ["backfill-prices", "backfill-history", "kb-archive", "replay"].map((j) => add(j));
    await tick();
    expect(net.github.length).toBe(MAX_PER_TICK);
    expect(req(ids[3]!).status).toBe("pending");
    await tick(T0 + MIN);
    expect(net.github.length).toBe(MAX_PER_TICK + 1);
    expect(req(ids[3]!).status).toBe("done");
  });

  it("does not touch the schedule's own slot state", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    add("backfill-prices");
    await tick();
    expect(rows(db, "SELECT key FROM worker_state WHERE key LIKE 'slot:%'")).toEqual([]);
  });
});

describe("safety gates a manual run still respects", () => {
  const refused = (id: number, why: string) =>
    expect(req(id)).toEqual({ status: "refused", result: `refused: ${why}` });

  it("refuses an unlisted go-live job, with no list, a list without it, and an unreadable list", async () => {
    dispatchOn();
    const a = add("backfill-prices");
    await tick(); // no list at all
    refused(a, "not listed");
    list(["morning"]);
    const b = add("backfill-prices");
    await tick(T0 + MIN);
    refused(b, "not listed");
    setState("slots_enabled", "not json");
    const c = add("backfill-prices");
    await tick(T0 + 2 * MIN);
    refused(c, "not listed");
    expect(net.github).toEqual([]);
    expect(appCalls).toEqual([]);
  });

  it("an always-on job does not need the list (as on schedule)", async () => {
    dispatchOn();
    const id = add("backup");
    await tick();
    expect(githubWorkflows()).toEqual(["backup.yml"]);
    expect(req(id).status).toBe("done");
  });

  it("refuses while the dispatch kill switch is off (even for backup)", async () => {
    const id = add("backup");
    await tick();
    refused(id, "dispatch is off");
    expect(net.github).toEqual([]);
  });

  it("refuses a market-bound job while the market is off, allows it in data-only", async () => {
    dispatchOn();
    list(["arena-close"]);
    marketMode("off");
    const a = add("arena-close");
    await tick();
    refused(a, "market is off");
    marketMode("data_only");
    const b = add("arena-close");
    await tick(T0 + MIN);
    expect(req(b).status).toBe("done");
    expect(githubWorkflows()).toEqual(["arena-close.yml"]);
  });

  it("refuses a trading-day job on a weekend or a day with no calendar row", async () => {
    dispatchOn();
    list(["arena-close", "arena-signals"]);
    const a = add("arena-close");
    await tick(SAT);
    refused(a, "not a trading day");
    const far = Date.UTC(2035, 2, 4, 16, 0); // Mon 5 Mar 2035: past the seeded calendar
    const b = add("arena-signals", "{}", far - MIN);
    await tick(far); // Mon 5 Mar 2035: past the seeded calendar
    refused(b, "not a trading day");
    expect(net.github).toEqual([]);
  });

  it("a job that runs every day is allowed on a weekend", async () => {
    dispatchOn();
    list(["evening-review"]);
    const id = add("evening-review");
    await tick(SAT);
    expect(req(id).status).toBe("done");
  });

  it("alert flush runs only when an alert is due; pre-open attempt 2 only if attempt 1 did not work", async () => {
    dispatchOn();
    list(["alert-flush", "pre-open-retry"]);
    marketMode("data_only");
    const a = add("alert-flush");
    await tick();
    refused(a, "nothing is due");
    setState("alert_flush_due", JSON.stringify("2020-01-01T00:00:00.000Z"));
    const b = add("alert-flush");
    await tick(T0 + MIN);
    expect(req(b).status).toBe("done");
    setState("slot:pre-open:2026-10-19", JSON.stringify({ s: "dispatched", n: 1, at: iso(T0) }));
    const c = add("pre-open-retry");
    await tick(T0 + 2 * MIN);
    refused(c, "attempt 1 already worked");
  });

  it("the bake-off needs its candidate inputs", async () => {
    dispatchOn();
    list(["llm-bakeoff"]);
    const a = add("llm-bakeoff");
    await tick();
    refused(a, "inputs missing");
    const slot = AU_SLOTS.find((s) => s.id === "llm-bakeoff")!;
    setState(
      slot.inputsKey!,
      JSON.stringify(Object.fromEntries((slot.requiredInputs ?? []).map((k) => [k, "x"]))),
    );
    const b = add("llm-bakeoff");
    await tick(T0 + MIN);
    expect(req(b).status).toBe("done");
  });

  it("refuses a job the registry does not allow by hand, an unknown job and bad parameters", async () => {
    dispatchOn();
    const a = add("asx-poll");
    const b = add("no-such-job");
    const c = add("backup", '{"d":"2026-10-19"}');
    await tick();
    refused(a, "unknown job");
    refused(b, "unknown job");
    refused(c, "bad request");
    expect(net.github).toEqual([]);
  });

  it("refuses a date outside the allowed window", async () => {
    dispatchOn();
    list(["evening-review"]);
    const a = add("evening-review", '{"d":"2026-10-10"}');
    const b = add("evening-review", '{"d":"2026-10-20"}'); // tomorrow
    await tick();
    refused(a, "bad request");
    refused(b, "bad request");
    expect(appCalls).toEqual([]);
  });

  it("planRequest agrees for a disabled slot in the table (worker-internal)", () => {
    const facts = {
      dispatchEnabled: true,
      marketMode: "full",
      slotsEnabled: { kind: "absent" as const },
      flushDue: false,
      slotInputs: {},
      states: new Map<string, string>(),
      calendar: new Map<string, string>(),
    };
    const p = planRequest({ id: 1, jobId: "universe", paramsJson: "{}" }, "2026-10-19", facts);
    expect(p).toEqual({ run: false, status: "refused", result: "refused: unknown job" });
  });
});

describe("expiry and idempotency", () => {
  it("expires a request nobody started within 30 minutes, without running it", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices", "{}", T0 - RUN_NOW_EXPIRY_MS - MIN);
    await tick();
    expect(req(id)).toEqual({ status: "expired", result: "expired: not started in 30 minutes" });
    expect(net.github).toEqual([]);
  });

  it("a claimed request whose result was never recorded expires, and is never run again", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices", "{}", T0 - RUN_NOW_EXPIRY_MS - MIN);
    db.prepare("UPDATE run_now_request SET status = 'dispatched' WHERE id = ?").run(id);
    await tick();
    expect(req(id)).toEqual({ status: "expired", result: "expired: no result was recorded" });
    expect(net.github).toEqual([]);
  });

  it("a claimed request expires 30 minutes after the claim, not after the request (D-853)", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices", "{}", T0 - RUN_NOW_EXPIRY_MS - MIN);
    db.prepare("UPDATE run_now_request SET status = 'dispatched', updated_at = ? WHERE id = ?").run(
      iso(T0 - MIN),
      id,
    );
    await tick();
    expect(req(id)).toEqual({ status: "dispatched", result: null });
    expect(net.github).toEqual([]);
    await tick(T0 + RUN_NOW_EXPIRY_MS);
    expect(req(id)).toEqual({ status: "expired", result: "expired: no result was recorded" });
    expect(net.github).toEqual([]);
  });

  it("two ticks (or two overlapping isolates) run a request once", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    add("backfill-prices");
    net.interleave = true;
    await Promise.all([tick(), tick(), tick(T0 + MIN)]);
    expect(net.github.length).toBe(1);
    await tick(T0 + 2 * MIN);
    expect(net.github.length).toBe(1);
  });

  it("a lost claim response never runs the job twice (it expires instead)", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices");
    net.failPipeline = false;
    // claim applied, then the Worker disappears: simulate by marking dispatched with no result
    db.prepare("UPDATE run_now_request SET status = 'dispatched' WHERE id = ?").run(id);
    await tick();
    await tick(T0 + MIN);
    expect(net.github).toEqual([]);
  });

  it("a database failure on the first request starts nothing and throws nothing", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices");
    net.failPipeline = true;
    await expect(tick()).resolves.toMatchObject({ requests: 1 });
    expect(net.github).toEqual([]);
    net.failPipeline = false;
    await tick(T0 + MIN);
    expect(req(id).status).toBe("done");
  });

  it("the status only moves forward and the request never changes (trigger)", async () => {
    dispatchOn();
    list(["backfill-prices"]);
    const id = add("backfill-prices");
    await tick();
    const upd = (sql: string) => () => db.prepare(sql).run(id);
    expect(upd("UPDATE run_now_request SET status = 'pending' WHERE id = ?")).toThrow(/forward/);
    expect(upd("UPDATE run_now_request SET status = 'refused' WHERE id = ?")).toThrow(/forward/);
    expect(upd("UPDATE run_now_request SET job_id = 'backup' WHERE id = ?")).toThrow(/forward/);
    expect(upd("DELETE FROM run_now_request WHERE id = ?")).toThrow(/append-only/);
  });
});

describe("budgets (PLT-070)", () => {
  it("a full tick (three requests) uses at most 3 database requests and 3 outside calls", async () => {
    dispatchOn();
    list(["backfill-prices", "evening-review", "morning"]);
    add("backfill-prices");
    add("evening-review");
    add("morning");
    const s = await tick();
    expect(net.pipelines).toBe(3);
    expect(net.github.length + appCalls.length).toBe(3);
    expect(s.requests).toBe(3);
  });

  it("an idle minute costs one request and little CPU", async () => {
    const before = process.cpuUsage();
    for (let i = 0; i < 20; i++) await tick(T0 + i * MIN);
    const used = process.cpuUsage(before);
    expect(net.pipelines).toBe(20);
    expect((used.user + used.system) / 1000 / 20).toBeLessThan(50); // ms per tick, fakes included
  });
});
