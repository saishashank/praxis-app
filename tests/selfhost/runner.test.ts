// @vitest-environment node
// INFRA T3 (REQ\infra\INFRA_REQUIREMENT.md §5.3): the local job runner. Real child processes (tiny node
// scripts written into a temp folder), a real SQLite database behind the hrana fake for the lease, no network.
// Covers: steps, outputs and conditions, per-step env, `$W`, the lease (concurrent start blocked, stale
// heartbeat allows, exclusive groups), the timeout (SIGTERM, then SIGKILL, status `timeout`), masking of the
// log, the failure alert, the queue, and pruning.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquire, recentRuns, recoverStale, runById, type LeaseDb } from "../../clock/lease";
import { makeMasker } from "../../clock/mask";
import { blockingJobs, validateManifest, type Job, type Manifest } from "../../clock/manifest";
import { LocalRunner, SCRATCH_KEEP_MS } from "../../clock/runner/local";
import { pipeline } from "../../worker/src/db";
import { makeDb, pipelineResponse, rows } from "./fakeDb";

const FAKE_TOKEN = ["abcdef", "123456"].join(""); // built at run time: a fake, not a secret

const SECRET = "tok-SECRETVALUE-123456";
const RAW: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  TURSO_MAIN_URL: "http://main.sqld:8080",
  TURSO_MAIN_TOKEN: SECRET,
  SECRET_ONE: "only-for-the-clock-0001",
  OWNER_EMAIL: "owner@example.test",
};

let dir: string;
let root: string;
let db: DatabaseSync;
let leaseDb: LeaseDb;
let lines: string[];
const script = (name: string, body: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, body);
  return p;
};
const dbEnv = { TURSO_MAIN_URL: "libsql://main.sqld", TURSO_MAIN_TOKEN: "t" };

function job(over: Partial<Job> & Pick<Job, "steps">): Job {
  return { workflow: "x.yml", timeoutMin: 1, group: "g", ...over };
}
function manifestOf(jobs: Record<string, Job>): Manifest {
  // distinct workflow files, as validateManifest wants
  let i = 0;
  for (const j of Object.values(jobs)) j.workflow = `w${i++}.yml`;
  return validateManifest({ version: 1, passthrough: [], jobs });
}
const stepEnv = (file: string, extra: Record<string, string> = {}) => ({
  NODE: "const:node",
  S: `const:${file}`,
  ...extra,
});
function runner(m: Manifest, o: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) {
  return new LocalRunner({
    manifest: m,
    env: RAW,
    db: leaseDb,
    root,
    cwd: dir,
    log: (l) => lines.push(l),
    heartbeatMs: 100,
    graceMs: 400,
    ...o,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "praxis-clock-"));
  root = path.join(dir, "jobs");
  mkdirSync(root);
  db = makeDb();
  lines = [];
  const f = (async (_u: string | URL | Request, init?: RequestInit) =>
    pipelineResponse(db, String(init?.body))) as typeof fetch;
  leaseDb = (stmts) => pipeline(dbEnv, stmts, f);
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows may hold a handle for a moment; the run temp folder is removed at the end
  }
});

describe("steps, outputs, conditions, env and $W", () => {
  it("runs the steps in order; outputs drive `if`; only the step's own env is visible; $W is the run dir", async () => {
    const plan = script(
      "plan.mjs",
      `import {appendFileSync,writeFileSync} from "node:fs";
       appendFileSync(process.env.GITHUB_OUTPUT, "fetch=true\\nchunk_size=7\\n");
       writeFileSync(process.env.W + "/made.txt", "x");
       console.log("planned");`,
    );
    const probe = script(
      "probe.mjs",
      `console.log(JSON.stringify(["SECRET_ONE","TURSO_MAIN_TOKEN","STEP_VAR","CHUNK","PATH","W","EMPTY_FLAG"].filter(n=>process.env[n]!==undefined)));`,
    );
    const m = manifestOf({
      one: job({
        steps: [
          { id: "plan", run: "$NODE $S", env: stepEnv(plan) },
          {
            id: "probe",
            run: "$NODE $S",
            if: "out:plan.fetch=true",
            env: {
              ...stepEnv(probe),
              STEP_VAR: "const:yes",
              CHUNK: "out:plan.chunk_size",
              TURSO_MAIN_TOKEN: "env",
            },
          },
          { id: "never", run: "$NODE $S", if: "out:plan.fetch=false", env: stepEnv(probe) },
        ],
      }),
    });
    const res = await runner(m).runNow({ job: "one" });
    expect(res.status).toBe("success");
    const log = readFileSync(path.join(root, "logs", `${res.id}-one.log`), "utf8");
    expect(log).toContain("planned");
    // visible: its own env (token by `env`, STEP_VAR, CHUNK from the output), PATH and W; not SECRET_ONE
    expect(log).toContain('["TURSO_MAIN_TOKEN","STEP_VAR","CHUNK","PATH","W"]');
    expect(log).toContain("step never: skipped");
    expect(existsSync(path.join(root, `run-${res.id}`, "made.txt"))).toBe(true);
    const row = await runById(leaseDb, res.id!);
    expect(row).toMatchObject({ job: "one", status: "success", exitCode: 0 });
    expect(row!.logPath).toBe(path.join(root, "logs", `${res.id}-one.log`));
  });

  it("a failed step fails the run; later steps are skipped unless `always`; an `if` on the outcome works", async () => {
    const fail = script("fail.mjs", `console.log("about to fail"); process.exit(3);`);
    const ok = script("ok.mjs", `console.log("ran");`);
    const m = manifestOf({
      two: job({
        steps: [
          { id: "plan", run: "$NODE $S", env: stepEnv(fail) },
          { id: "skipme", run: "$NODE $S", env: stepEnv(ok) },
          {
            id: "cleanup",
            run: "$NODE $S",
            always: true,
            if: "outcome:plan=failure",
            env: stepEnv(ok),
          },
          {
            id: "needs-success",
            run: "$NODE $S",
            always: true,
            if: "outcome:plan=success",
            env: stepEnv(ok),
          },
        ],
      }),
    });
    const notified: unknown[] = [];
    const res = await runner(m, { notify: async (i) => notified.push(i) }).runNow({ job: "two" });
    expect(res).toMatchObject({ status: "failed", exitCode: 3 });
    const log = readFileSync(path.join(root, "logs", `${res.id}-two.log`), "utf8");
    expect(log).not.toMatch(/step skipme: .*node/);
    expect(log).toContain("ran"); // cleanup ran
    expect(log).toContain("step needs-success: skipped");
    expect(notified).toEqual([{ job: "two", runId: res.id, status: "failed", exitCode: 3 }]);
    expect(await runById(leaseDb, res.id!)).toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("a command that cannot start fails the step with 127", async () => {
    const m = manifestOf({ three: job({ steps: [{ run: "no-such-program-xyz" }] }) });
    const res = await runner(m).runNow({ job: "three" });
    expect(res).toMatchObject({ status: "failed", exitCode: 127 });
  });

  it("standbyExitCodes: the run ends as `standby` with no alert and no later step; okExitCodes count as success", async () => {
    const c3 = script("c3.mjs", `console.log("guard refused"); process.exit(3);`);
    const c4 = script("c4.mjs", `process.exit(4);`);
    const ok = script("ok.mjs", `console.log("should not run");`);
    const m = manifestOf({
      sb: job({
        standbyExitCodes: [3],
        steps: [
          { id: "a", run: "$NODE $S", env: stepEnv(c3) },
          { id: "b", run: "$NODE $S", env: stepEnv(ok) },
        ],
      }),
      okc: job({ okExitCodes: [4], steps: [{ run: "$NODE $S", env: stepEnv(c4) }] }),
      other: job({ standbyExitCodes: [3], steps: [{ run: "$NODE $S", env: stepEnv(c4) }] }),
    });
    const notified: unknown[] = [];
    const r = runner(m, { notify: async (i) => notified.push(i) });
    const res = await r.runNow({ job: "sb" });
    expect(res).toMatchObject({ status: "standby", exitCode: 3 });
    expect(await runById(leaseDb, res.id!)).toMatchObject({ status: "standby", exitCode: 3 });
    expect(readFileSync(path.join(root, "logs", `${res.id}-sb.log`), "utf8")).not.toContain(
      "should not run",
    );
    expect(await r.runNow({ job: "okc" })).toMatchObject({ status: "success", exitCode: 0 });
    expect(await r.runNow({ job: "other" })).toMatchObject({ status: "failed", exitCode: 4 });
    expect(notified).toEqual([expect.objectContaining({ job: "other", status: "failed" })]);
    // a standby run does not hold the lease
    expect((await r.runNow({ job: "sb" })).status).toBe("standby");
  });

  it("no retries: one failed run is one row", async () => {
    const fail = script("fail.mjs", `process.exit(1);`);
    const m = manifestOf({ four: job({ steps: [{ run: "$NODE $S", env: stepEnv(fail) }] }) });
    await runner(m).runNow({ job: "four" });
    expect(rows(db, "SELECT count(*) AS n FROM job_run")[0]!.n).toBe(1);
  });
});

describe("the lease", () => {
  const A = (over: Partial<Parameters<typeof acquire>[1]> = {}) => ({
    job: "arena-close",
    slotId: null,
    localDate: "2026-11-03",
    blocking: ["arena-close", "arena-signals"],
    nowMs: Date.parse("2026-11-03T07:00:00Z"),
    ...over,
  });

  it("a second start in the same group is blocked while the first heartbeat is fresh", async () => {
    const first = await acquire(leaseDb, A());
    expect(first).toBeGreaterThan(0);
    expect(await acquire(leaseDb, A({ nowMs: Date.parse("2026-11-03T07:01:00Z") }))).toBeNull();
    // exactly one running row
    expect(rows(db, "SELECT count(*) AS n FROM job_run WHERE status = 'running'")[0]!.n).toBe(1);
  });

  it("a stale heartbeat (older than 2 minutes) frees the group", async () => {
    await acquire(leaseDb, A());
    const later = Date.parse("2026-11-03T07:02:01Z");
    expect(await acquire(leaseDb, A({ nowMs: later }))).toBeGreaterThan(0);
    // exactly 2 minutes is still held
    const db2 = makeDb();
    const f = (async (_u: string | URL | Request, init?: RequestInit) =>
      pipelineResponse(db2, String(init?.body))) as typeof fetch;
    const l2: LeaseDb = (s) => pipeline(dbEnv, s, f);
    await acquire(l2, A());
    expect(await acquire(l2, A({ nowMs: Date.parse("2026-11-03T07:01:59Z") }))).toBeNull();
  });

  it("different groups run side by side; exclusive jobs block each other; a job blocks itself", async () => {
    const m = manifestOf({
      "arena-close": job({
        group: "arena-close",
        exclusiveWith: ["arena-signals"],
        steps: [{ run: "x" }],
      }),
      "arena-signals": job({
        group: "arena-signals",
        exclusiveWith: ["arena-close"],
        steps: [{ run: "x" }],
      }),
      maintenance: job({ group: "maintenance", steps: [{ run: "x" }] }),
    });
    expect(blockingJobs(m, "arena-close")).toEqual(["arena-close", "arena-signals"]);
    expect(blockingJobs(m, "maintenance")).toEqual(["maintenance"]);
    const now = Date.parse("2026-11-03T07:00:00Z");
    const idClose = await acquire(
      leaseDb,
      A({ blocking: blockingJobs(m, "arena-close"), nowMs: now }),
    );
    expect(idClose).toBeGreaterThan(0);
    expect(
      await acquire(
        leaseDb,
        A({ job: "arena-signals", blocking: blockingJobs(m, "arena-signals"), nowMs: now }),
      ),
    ).toBeNull();
    expect(
      await acquire(
        leaseDb,
        A({ job: "maintenance", blocking: blockingJobs(m, "maintenance"), nowMs: now }),
      ),
    ).toBeGreaterThan(0);
    expect(
      await acquire(leaseDb, A({ blocking: blockingJobs(m, "arena-close"), nowMs: now })),
    ).toBeNull();
  });

  it("a finished run no longer blocks", async () => {
    const id = (await acquire(leaseDb, A()))!;
    db.prepare("UPDATE job_run SET status = 'success' WHERE id = ?").run(id);
    expect(
      await acquire(leaseDb, A({ nowMs: Date.parse("2026-11-03T07:00:05Z") })),
    ).toBeGreaterThan(0);
  });

  it("recoverStale marks the runs of a dead runner failed (a restart does not resurrect them)", async () => {
    const id = (await acquire(leaseDb, A()))!;
    expect(await recoverStale(leaseDb, Date.parse("2026-11-03T07:01:00Z"))).toBe(0);
    expect(await recoverStale(leaseDb, Date.parse("2026-11-03T07:05:00Z"))).toBe(1);
    expect((await runById(leaseDb, id))!.status).toBe("failed");
  });

  it("two simultaneous runNow of the same job: one runs, one is blocked; the exclusive partner is blocked too", async () => {
    const sleep = script("sleep.mjs", `setTimeout(()=>console.log("done"), 600);`);
    const m = manifestOf({
      "arena-close": job({
        group: "arena-close",
        exclusiveWith: ["arena-signals"],
        steps: [{ run: "$NODE $S", env: stepEnv(sleep) }],
      }),
      "arena-signals": job({
        group: "arena-signals",
        exclusiveWith: ["arena-close"],
        steps: [{ run: "$NODE $S", env: stepEnv(sleep) }],
      }),
    });
    const r = runner(m);
    const [a, b, c] = await Promise.all([
      r.runNow({ job: "arena-close" }),
      r.runNow({ job: "arena-close" }),
      r.runNow({ job: "arena-signals" }),
    ]);
    const statuses = [a.status, b.status, c.status].sort();
    expect(statuses).toEqual(["blocked", "blocked", "success"]);
    // once finished, the partner may run
    expect((await r.runNow({ job: "arena-signals" })).status).toBe("success");
  });

  it("the runner heartbeats while a job runs (the lease stays fresh)", async () => {
    const sleep = script("sleep.mjs", `setTimeout(()=>{}, 700);`);
    const m = manifestOf({ hb: job({ steps: [{ run: "$NODE $S", env: stepEnv(sleep) }] }) });
    const res = await runner(m).runNow({ job: "hb" });
    const row = (await runById(leaseDb, res.id!))!;
    expect(Date.parse(row.heartbeatAt)).toBeGreaterThan(Date.parse(row.startedAt) + 300);
  });
});

describe("the timeout", () => {
  it("SIGTERM at the limit, SIGKILL after the grace, status timeout, failure alert", async () => {
    // Ignores SIGTERM where signals exist (posix); on Windows SIGTERM already ends the process.
    const stubborn = script(
      "stubborn.mjs",
      `process.on("SIGTERM", () => console.log("got SIGTERM, ignoring"));
       console.log("started"); setInterval(() => {}, 1000);`,
    );
    const m = manifestOf({
      slow: job({
        timeoutMin: 0.03,
        steps: [
          { run: "$NODE $S", env: stepEnv(stubborn) },
          { run: "$NODE $S", always: true, env: stepEnv(stubborn) },
        ],
      }),
    });
    const notified: { status: string }[] = [];
    const t0 = Date.now();
    const res = await runner(m, { graceMs: 500, notify: async (i) => notified.push(i) }).runNow({
      job: "slow",
    });
    const took = Date.now() - t0;
    expect(res.status).toBe("timeout");
    expect(await runById(leaseDb, res.id!)).toMatchObject({ status: "timeout" });
    expect(notified).toEqual([expect.objectContaining({ status: "timeout" })]);
    const log = readFileSync(path.join(root, "logs", `${res.id}-slow.log`), "utf8");
    expect(log).toContain("timeout after 0.03 min: sending SIGTERM");
    expect(log).toContain("end timeout");
    // the second step never starts after a timeout, even with `always`
    expect(log.match(/step s2:/g) ?? []).toHaveLength(0);
    if (process.platform !== "win32") {
      expect(log).toContain("got SIGTERM, ignoring");
      expect(log).toContain("sending SIGKILL");
      expect(took).toBeGreaterThanOrEqual(1800 + 500 - 50); // limit 1.8 s + grace
    } else {
      expect(took).toBeGreaterThanOrEqual(1700);
    }
  }, 20_000);

  it("a job that ends inside its limit is not killed and no kill timer lingers", async () => {
    const quick = script("quick.mjs", `console.log("quick");`);
    const m = manifestOf({
      fast: job({ timeoutMin: 0.5, steps: [{ run: "$NODE $S", env: stepEnv(quick) }] }),
    });
    const res = await runner(m).runNow({ job: "fast" });
    expect(res.status).toBe("success");
  });
});

describe("masking and logs", () => {
  it("masks the value of every secret in the log file and on the console", async () => {
    const leak = script(
      "leak.mjs",
      `console.log("token=" + process.env.TURSO_MAIN_TOKEN);
       console.error("owner " + process.env.OWNER_EMAIL + " host main.sqld:8080");
       console.log("Authorization: Bearer abcdefghijklmnop12345");
       console.log("https://user:pw12345@example.test/x");`,
    );
    const m = manifestOf({
      leak: job({
        steps: [
          {
            run: "$NODE $S",
            env: stepEnv(leak, { TURSO_MAIN_TOKEN: "env", OWNER_EMAIL: "env" }),
          },
        ],
      }),
    });
    const res = await runner(m).runNow({ job: "leak" });
    const file = readFileSync(path.join(root, "logs", `${res.id}-leak.log`), "utf8");
    const all = file + lines.join("\n");
    expect(file).toContain("token=***");
    for (const secret of [SECRET, "owner@example.test", "abcdefghijklmnop12345", "pw12345"]) {
      expect(all, secret).not.toContain(secret);
    }
    expect(lines.some((l) => l.startsWith(`[leak#${res.id}] token=***`))).toBe(true);
  });

  it("makeMasker: names by pattern and by list, short values and unset names are ignored, longest first", () => {
    const mask = makeMasker({
      A_TOKEN: FAKE_TOKEN,
      B_SECRET: "abc", // too short to mask
      TURSO_MAIN_URL: "http://main.sqld:8080",
      PLAIN: "visible-value",
      NESTED_KEY: `${FAKE_TOKEN}-and-more`,
      UNSET_KEY: undefined,
    });
    expect(mask(`x ${FAKE_TOKEN} y`)).toBe("x *** y");
    expect(mask("abc visible-value")).toBe("abc visible-value");
    expect(mask("go to main.sqld:8080 now")).toBe("go to *** now");
    expect(mask(`${FAKE_TOKEN}-and-more`)).toBe("***");
  });

  it("the console sink of the runner never receives an unmasked secret", async () => {
    const m = manifestOf({
      quiet: job({
        steps: [
          {
            run: "$NODE $S",
            env: stepEnv(script("q.mjs", `console.log(process.env.TURSO_MAIN_TOKEN)`), {
              TURSO_MAIN_TOKEN: "env",
            }),
          },
        ],
      }),
    });
    await runner(m).runNow({ job: "quiet" });
    expect(lines.join("\n")).not.toContain(SECRET);
  });
});

describe("the queue (the clock's dispatch path)", () => {
  it("enqueue: unknown job, duplicate of a waiting one, and a blocked run starts once the lease frees", async () => {
    const sleep = script("sleep.mjs", `setTimeout(()=>console.log("done"), 400);`);
    const m = manifestOf({ q: job({ steps: [{ run: "$NODE $S", env: stepEnv(sleep) }] }) });
    const r = runner(m);
    expect(r.enqueue({ job: "nope" })).toBe("unknown-job");
    expect(r.enqueue({ job: "q" })).toBe("queued");
    await new Promise((res) => setTimeout(res, 150)); // the first is running now
    expect(r.running()).toHaveLength(1);
    expect(r.enqueue({ job: "q", inputs: { a: "1" } })).toBe("queued"); // waits for the lease
    expect(r.enqueue({ job: "q", inputs: { a: "1" } })).toBe("duplicate");
    expect(r.queued()).toHaveLength(1);
    await r.idle();
    // the finished run triggers a pump: the waiting one runs; wait for it
    await new Promise((res) => setTimeout(res, 100));
    await r.idle();
    const runs = await recentRuns(leaseDb, 10, "q");
    expect(runs.map((x) => x.status)).toEqual(["success", "success"]);
    expect(r.queued()).toHaveLength(0);
  }, 20_000);

  it("a run that waits longer than the limit is dropped as `skipped`", async () => {
    const m = manifestOf({
      q2: job({
        steps: [{ run: "$NODE $S", env: stepEnv(script("s.mjs", `setTimeout(()=>{}, 600)`)) }],
      }),
    });
    let t = Date.now();
    const r = runner(m, { maxWaitMs: 1000, now: () => t });
    r.enqueue({ job: "q2" });
    await new Promise((res) => setTimeout(res, 100));
    r.enqueue({ job: "q2", inputs: { x: "y" } });
    await new Promise((res) => setTimeout(res, 100)); // its first pump finishes: still waiting
    expect(r.queued()).toHaveLength(1);
    t += 5000;
    await r.pump();
    expect(r.queued()).toHaveLength(0);
    expect(rows(db, "SELECT status FROM job_run WHERE status = 'skipped'")).toHaveLength(1);
    await r.idle();
  }, 20_000);
});

describe("pruning", () => {
  it("removes scratch dirs older than 3 days and keeps newer ones", () => {
    const m = manifestOf({ p: job({ steps: [{ run: "x" }] }) });
    const r = runner(m);
    const oldDir = path.join(root, "run-1");
    const newDir = path.join(root, "run-2");
    mkdirSync(oldDir);
    mkdirSync(newDir);
    const old = new Date(Date.now() - SCRATCH_KEEP_MS - 3_600_000);
    utimesSync(oldDir, old, old);
    expect(r.prune()).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(newDir)).toBe(true);
  });
});
