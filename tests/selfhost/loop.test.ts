// @vitest-environment node
// INFRA T3 (REQ\infra\INFRA_REQUIREMENT.md §5.1, §6): the tick loop. A new minute runs the Worker runners
// once; a second tick in the same minute does only sub-minute work; `CLOCK_ENABLED=0` reads nothing; a
// minute a slow tick skipped is caught up for the UTC crons; an unreadable owner key fires nothing; the CLI
// stubs exit 2. Real SQLite behind the hrana fake; the Worker runners are stubbed here (clock-week covers them).
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClock, tickKey } from "../../clock/loop";
import { loadManifest } from "../../clock/manifest";
import { makeDb, pipelineResponse, rows, setState } from "./fakeDb";

const RAW = {
  PRAXIS_ENV: "production",
  PRAXIS_RUNTIME: "selfhost",
  TURSO_MAIN_URL: "http://main.sqld:8080",
  TURSO_MAIN_TOKEN: "tok-test-main",
  APP_BASE_URL: "http://web:3000",
  WORKER_HMAC_SECRET: "7".repeat(64),
  CRON_SECRET: "cron-secret-test-0123456789",
};
const NO_ENV = {} as NodeJS.ProcessEnv;
const manifest = loadManifest(path.resolve(import.meta.dirname, "../../deploy/selfhost/jobs.json"));

let db: DatabaseSync;
let pipelines: number;
let gets: string[];
let failDb: boolean;
let now: number;

function make(raw: Record<string, string> = RAW) {
  const worker = vi.fn().mockResolvedValue(undefined);
  const queued: string[] = [];
  const clock = createClock({
    rawEnv: raw,
    manifest,
    nowMs: () => now,
    log: () => {},
    root: "unused",
    runWorker: worker,
    realFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v2/pipeline")) {
        pipelines++;
        if (failDb) return new Response("no", { status: 500 });
        return pipelineResponse(db, String(init?.body));
      }
      if (url.startsWith("http://web:3000/")) {
        gets.push(url);
        return Response.json({ ok: true });
      }
      throw new Error("unexpected");
    }) as typeof fetch,
  });
  clock.runner.enqueue = (r) => {
    queued.push(r.job);
    return "queued";
  };
  return { clock, worker, queued };
}

beforeEach(() => {
  db = makeDb();
  pipelines = 0;
  gets = [];
  failDb = false;
  now = Date.parse("2026-11-03T05:00:10Z"); // 16:00:10 AEDT, no cron due
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("a tick", () => {
  it("a new minute runs the Worker runners once with the start of the minute; the same minute again does not", async () => {
    setState(db, "clock_owner", '"selfhost"');
    const { clock, worker } = make();
    const r1 = await clock.tick(now);
    expect(r1.newMinute).toBe(true);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker.mock.calls[0]![1]).toBe(Date.parse("2026-11-03T05:00:00Z"));
    const r2 = await clock.tick(now + 30_000);
    expect(r2.newMinute).toBe(false);
    expect(worker).toHaveBeenCalledTimes(1);
    const r3 = await clock.tick(now + 60_000);
    expect(r3.newMinute).toBe(true);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(worker.mock.calls[1]![1]).toBe(Date.parse("2026-11-03T05:01:00Z"));
  });

  it("writes this runtime's tick record and reads the owner (one request) for the health endpoint", async () => {
    setState(db, "clock_owner", '"selfhost"');
    const { clock } = make();
    await clock.tick(now);
    expect(clock.health.owner).toBe("selfhost");
    expect(clock.health.lastTickMs).toBe(now);
    const r = rows(db, "SELECT value_json FROM worker_state WHERE key = ?", tickKey("selfhost"));
    expect(JSON.parse(String(r[0]!.value_json))).toEqual({ at: new Date(now).toISOString() });
    expect(pipelines).toBe(2); // the tick: one request for the tick record and owner, one daily prune (first tick of the day)
    // a same-minute tick makes no request at all
    await clock.tick(now + 30_000);
    expect(pipelines).toBe(2);
  });

  it("owner cloud is shown in health, and the tick still runs the runners (they gate themselves)", async () => {
    setState(db, "clock_owner", '"cloud"');
    const { clock, worker } = make();
    await clock.tick(now);
    expect(clock.health.owner).toBe("cloud");
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("a database outage is a fixed health word, not an exception, and the runners still get their turn", async () => {
    failDb = true;
    const { clock, worker } = make();
    await expect(clock.tick(now)).resolves.toMatchObject({ newMinute: true });
    expect(clock.health.owner).toBeNull();
    expect(clock.health.lastError?.what).toBe("database unreachable");
    expect(worker).toHaveBeenCalledTimes(1);
  });
});

describe("CLOCK_ENABLED=0", () => {
  it("reads nothing, writes nothing, runs nothing; health says disabled", async () => {
    const { clock, worker } = make({ ...RAW, CLOCK_ENABLED: "0" });
    const r = await clock.tick(now);
    expect(r.skipped).toBe("disabled");
    expect(pipelines).toBe(0);
    expect(worker).not.toHaveBeenCalled();
    expect(clock.health.enabled).toBe(false);
    expect(rows(db, "SELECT key FROM worker_state")).toEqual([]);
  });
});

describe("UTC crons in the loop", () => {
  it("fires a Vercel cron once at its minute (Bearer CRON_SECRET), not on the second tick of that minute", async () => {
    setState(db, "clock_owner", '"selfhost"');
    const { clock } = make();
    now = Date.parse("2026-11-03T00:20:05Z");
    await clock.tick(now);
    await clock.tick(now + 30_000);
    expect(gets).toEqual(["http://web:3000/api/cron/heartbeat-morning"]);
  });

  it("catches up a cron minute that a slow tick skipped (at most 5 minutes back)", async () => {
    setState(db, "clock_owner", '"selfhost"');
    const { clock } = make();
    now = Date.parse("2026-11-03T00:19:30Z");
    await clock.tick(now);
    now = Date.parse("2026-11-03T00:22:10Z"); // the 00:20 minute was never ticked
    await clock.tick(now);
    expect(gets).toEqual(["http://web:3000/api/cron/heartbeat-morning"]);
    // older than 5 minutes is not caught up
    now = Date.parse("2026-11-03T00:50:10Z"); // 00:50 itself is due and fires
    await clock.tick(now);
    expect(gets).toHaveLength(2);
    now = Date.parse("2026-11-03T01:30:10Z");
    await clock.tick(now);
    expect(gets).toHaveLength(2);
  });

  it("an unreadable owner key fires nothing; the standby owner fires nothing", async () => {
    const { clock } = make();
    now = Date.parse("2026-11-03T00:20:05Z");
    failDb = true;
    await clock.tick(now);
    expect(gets).toEqual([]);
    failDb = false;
    setState(db, "clock_owner", '"cloud"');
    now = Date.parse("2026-11-03T00:50:05Z");
    const r = await clock.tick(now);
    expect(gets).toEqual([]);
    expect(r.utc.some((u) => u.standby)).toBe(true);
  });
});

describe("start-up", () => {
  it("selfCheck names what failed, never a value; recover marks a dead run failed", async () => {
    const { clock } = make({ ...RAW, WORKER_HMAC_SECRET: "short" });
    const c = await clock.selfCheck();
    expect(c.failed).toEqual(["signing-secret"]);
    expect(c).toMatchObject({ passed: 3, total: 4 });
    expect(clock.health.selfCheck).toMatchObject({
      passed: 3,
      total: 4,
      failed: ["signing-secret"],
    });
    db.prepare(
      "INSERT INTO job_run (job, local_date, status, started_at, heartbeat_at) VALUES ('backup','2026-11-03','running','2026-11-03T00:00:00.000Z','2026-11-03T00:00:00.000Z')",
    ).run();
    expect(await clock.recover()).toBe(1);
    expect(rows(db, "SELECT status FROM job_run")[0]!.status).toBe("failed");
  });
});

describe("local-only scheduled jobs and the daily prune", () => {
  it("only the owner queues them, at their Sydney time, with a local: slot id", async () => {
    setState(db, "clock_owner", '"selfhost"');
    const { clock, queued } = make();
    now = Date.parse("2026-11-03T12:40:10Z"); // 23:40 AEDT Tuesday
    await clock.tick(now);
    expect(queued).toEqual(["turso-refresh"]);
    now = Date.parse("2026-11-03T20:05:10Z"); // 07:05 AEDT Wednesday
    await clock.tick(now);
    expect(queued).toEqual(["turso-refresh", "bucket-hourly"]);
    setState(db, "clock_owner", '"cloud"');
    now = Date.parse("2026-11-03T21:05:10Z"); // 08:05
    await clock.tick(now);
    expect(queued).toHaveLength(2);
  });

  it("prunes job_run rows older than 30 days once per Sydney day, never a running row", async () => {
    const ins = (id: number, status: string, at: string) =>
      db
        .prepare(
          "INSERT INTO job_run (id, job, local_date, status, started_at, heartbeat_at) VALUES (?, 'backup', '2026-01-01', ?, ?, ?)",
        )
        .run(id, status, at, at);
    ins(1, "success", "2026-09-01T00:00:00.000Z");
    ins(2, "running", "2026-09-01T00:00:00.000Z");
    ins(3, "success", "2026-10-30T00:00:00.000Z");
    const { clock } = make();
    await clock.tick(now);
    expect(rows(db, "SELECT id FROM job_run ORDER BY id").map((r) => r.id)).toEqual([2, 3]);
    ins(4, "failed", "2026-09-02T00:00:00.000Z");
    await clock.tick(now + 60_000); // same day: no second delete
    expect(rows(db, "SELECT id FROM job_run ORDER BY id").map((r) => r.id)).toEqual([2, 3, 4]);
    await clock.tick(now + 86_400_000); // next day
    expect(rows(db, "SELECT id FROM job_run ORDER BY id").map((r) => r.id)).toEqual([2, 3]);
  });
});

describe("the operator CLI", () => {
  it("the stubs print the not-built message and exit 2; an unknown command prints usage and exits 2", () => {
    const cli = path.resolve(import.meta.dirname, "../../clock/cli.mjs");
    for (const cmd of ["deploy"]) {
      const r = spawnSync(process.execPath, [cli, cmd], { encoding: "utf8", env: NO_ENV });
      expect(r.status, cmd).toBe(2);
      expect(r.stdout.trim(), cmd).toBe("not built yet (T7)");
    }
    const rd = spawnSync(process.execPath, [cli, "restore-drill", "--bogus"], {
      encoding: "utf8",
      env: NO_ENV,
    });
    expect(rd.status).toBe(2);
    expect(rd.stdout).toContain("usage: praxis restore-drill");
    const bad = spawnSync(process.execPath, [cli, "frobnicate"], { encoding: "utf8", env: NO_ENV });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("usage: praxis");
    // owner with a bad argument: usage, exit 2, before any database call
    const o = spawnSync(process.execPath, [cli, "owner", "mars"], {
      encoding: "utf8",
      env: NO_ENV,
    });
    expect(o.status).toBe(2);
    // no database configured: a plain message, exit 1, no stack and no value
    const s = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", env: NO_ENV });
    expect(s.status).toBe(1);
    expect(s.stdout).toContain("failed:");
  });
});
