// The clock loop of praxis-clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.1). `createClock` wires the
// pieces; `tick(nowMs)` is called every 30 s by `main.ts` (and per simulated minute by the tests):
//  1. same Sydney (= UTC) minute as the last tick: only sub-minute work, which is none in phase 1 (the
//     queue of waiting jobs is retried);
//  2. a new minute: one request writes this clock's own tick record and reads `clock_owner` (for `praxis
//     owner` and the health endpoint), then the UTC crons due in the minutes since the last tick fire
//     (crons.ts; a minute missed by a slow tick is caught up, at most 5 back), then every Worker runner runs
//     for this minute (adapter.ts). The runners read the owner key in their own single read and act only when
//     it names this runtime (INFRA T1), so a standby clock dispatches nothing.
//  3. `CLOCK_ENABLED=0`: nothing is read; only health is served.
import { pipeline } from "../worker/src/db";
import { sydneyLocal } from "../worker/src/localtime";
import { CLOCK_OWNER_KEY, ownerFrom, runtimeOf } from "../worker/src/owner";
import { runWorkerRunners, type WorkerDeps } from "./adapter";
import { buildClockEnv, type RawEnv, type TickEnv } from "./env";
import { healthBody, newHealthState, noteError, type HealthState } from "./health";
import { pruneOld, recoverStaleRows, type LeaseDb } from "./lease";
import { makeMasker } from "./mask";
import { jobForWorkflow, localJobsDue, type Manifest } from "./manifest";
import { createMonitor, type Monitor } from "./monitor";
import { sendAlertEmail, sendFailureEmail } from "./notify";
import { LocalRunner, type RunRequest } from "./runner/local";
import { makeClockFetch, type EnqueueResult } from "./shim";
import { runUtcCrons, type UtcSummary } from "./utc";

export const MAX_CATCH_UP_MIN = 5;
export const MINUTE_MS = 60_000;
export const tickKey = (runtime: string): string => `clock_tick:${runtime}`;

export type ClockOptions = {
  /** The container environment (jobs.env). */
  rawEnv: RawEnv;
  manifest: Manifest;
  realFetch?: typeof fetch;
  nowMs?: () => number;
  log?: (line: string) => void;
  /** Host directory of scratch dirs and logs. */
  root?: string;
  cwd?: string;
  /** Tests: replaces the Worker runners. */
  runWorker?: (env: TickEnv, scheduledTime: number, deps: WorkerDeps) => Promise<void>;
  /** Tests: replaces the failure email. */
  notify?: (info: {
    job: string;
    runId: number;
    status: string;
    exitCode: number | null;
  }) => Promise<unknown>;
  runnerOptions?: Partial<ConstructorParameters<typeof LocalRunner>[0]>;
};

export type TickResult = {
  minute: number;
  newMinute: boolean;
  skipped?: "disabled" | "busy";
  utc: UtcSummary[];
};

export type Clock = {
  tick(ms?: number): Promise<TickResult>;
  runner: LocalRunner;
  health: HealthState;
  /** The shimmed fetch (dispatch intercept, origin map). */
  fetch: typeof fetch;
  leaseDb: LeaseDb;
  env: TickEnv;
  enqueue(req: RunRequest): EnqueueResult;
  /** Start-up checks: database, app, signing secret, mail. Names only; never throws. */
  selfCheck(): Promise<{ passed: number; total: number; failed: string[] }>;
  /** Marks runs of a dead runner (stale heartbeat) as failed. */
  recover(): Promise<number>;
  /** Dead-man ping, host checks and idle trend (INFRA T6); main.ts drives it. */
  monitor: Monitor;
};

export function createClock(o: ClockOptions): Clock {
  const nowMs = o.nowMs ?? Date.now;
  const log = o.log ?? ((l: string) => console.log(l));
  const realFetch = o.realFetch ?? ((i, init) => fetch(i, init));
  const env = o.rawEnv;
  const built = buildClockEnv(env);
  const mask = makeMasker(env);
  const say = (l: string): void => log(mask(l));
  const runtime = runtimeOf(built.env);
  const enabled = (env.CLOCK_ENABLED ?? "1").trim() !== "0";
  const health = newHealthState({ nowMs: nowMs(), enabled, runtime, build: env.BUILD_COMMIT });

  // The runner and the fetch refer to each other: the fetch queues jobs, the runner needs the fetch for its
  // lease statements. `runnerRef` closes the loop.
  let runnerRef: LocalRunner | null = null;
  const enqueue = (req: RunRequest): EnqueueResult => runnerRef!.enqueue(req);
  const fetchShim = makeClockFetch({
    realFetch,
    passthrough: o.manifest.passthrough,
    origins: built.origins,
    log: say,
    enqueue: (d) => {
      const job = jobForWorkflow(o.manifest, d.workflow);
      return job === null ? "unknown-job" : enqueue({ job, slotId: null, inputs: d.inputs });
    },
  });
  const leaseDb: LeaseDb = (stmts) => pipeline(built.env, stmts, fetchShim);
  const failureNotify = o.notify ?? ((info) => sendFailureEmail(env, info, realFetch));
  const runner = new LocalRunner({
    manifest: o.manifest,
    env,
    db: leaseDb,
    root: o.root ?? env.JOBS_ROOT ?? "/srv/praxis/jobs",
    cwd: o.cwd,
    now: nowMs,
    log: say,
    mask,
    notify: failureNotify,
    ...o.runnerOptions,
  });
  runnerRef = runner;

  const deps: WorkerDeps = { fetch: fetchShim, nowMs };
  const runWorker = o.runWorker ?? runWorkerRunners;
  let lastMinute: number | null = null;
  let busy = false;
  let prunedOn: string | null = null;

  async function readOwnerAndMark(ms: number): Promise<"cloud" | "selfhost" | null> {
    try {
      const at = new Date(ms).toISOString();
      const res = await leaseDb([
        {
          sql:
            "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
          args: [tickKey(runtime), JSON.stringify({ at }), at],
        },
        { sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [CLOCK_OWNER_KEY] },
      ]);
      const cell = res[1]?.rows[0]?.[0];
      health.owner = ownerFrom(cell === undefined || cell === null ? undefined : String(cell));
    } catch {
      health.owner = null;
      noteError(health, ms, "database unreachable");
    }
    return health.owner;
  }

  async function tick(ms: number = nowMs()): Promise<TickResult> {
    const minute = Math.floor(ms / MINUTE_MS);
    const result: TickResult = { minute, newMinute: false, utc: [] };
    if (!enabled) return { ...result, skipped: "disabled" };
    if (busy) return { ...result, skipped: "busy" };
    busy = true;
    try {
      health.lastTickMs = ms;
      await runner.pump(); // sub-minute work: retry jobs that waited for their lease
      if (lastMinute !== null && minute <= lastMinute) return result;
      result.newMinute = true;
      const from =
        lastMinute === null ? minute : Math.max(lastMinute + 1, minute - MAX_CATCH_UP_MIN);
      lastMinute = minute;
      const owner = await readOwnerAndMark(ms);
      const local = sydneyLocal(minute * MINUTE_MS);
      if (prunedOn !== local.date) {
        // once a day: one DELETE of job_run rows older than 30 days
        prunedOn = local.date;
        await pruneOld(leaseDb, ms).catch(() => 0);
      }
      for (let m = from; m <= minute; m++) {
        result.utc.push(
          await runUtcCrons(built.env, m * MINUTE_MS, {
            fetch: fetchShim,
            nowMs,
            enqueue,
            log: say,
            cronSecret: env.CRON_SECRET,
          }),
        );
      }
      // Self-hosted-only scheduled jobs (jobs.json `localSchedule`): only while this clock is the owner.
      // N2: same catch-up window as the UTC crons above (a missed tick must not skip a once-a-day job); every minute is
      // visited once (`from` starts after the last visited one), so nothing fires twice.
      if (owner === "selfhost" && runtime === "selfhost") {
        for (let m = from; m <= minute; m++) {
          const at = sydneyLocal(m * MINUTE_MS);
          for (const name of localJobsDue(o.manifest, at.minute, at.dow)) {
            const res = enqueue({ job: name, slotId: `local:${name}` });
            say(`clock: local job ${name} (${res})${m === minute ? "" : " [catch-up]"}`);
          }
        }
      }
      await runWorker(built.env, minute * MINUTE_MS, deps);
      return result;
    } finally {
      busy = false;
    }
  }

  async function selfCheck(): Promise<{ passed: number; total: number; failed: string[] }> {
    const failed: string[] = [];
    const total = 4;
    try {
      await leaseDb([{ sql: "SELECT 1" }]);
    } catch {
      failed.push("database");
    }
    try {
      const res = await fetchShim(new URL("/api/health", built.env.APP_BASE_URL).toString(), {
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (res.status >= 500) failed.push("app");
    } catch {
      failed.push("app");
    }
    if ((env.WORKER_HMAC_SECRET ?? "").trim().length < 16) failed.push("signing-secret");
    if (
      (env.EMAIL_PROVIDER ?? "").trim().toLowerCase() === "resend" &&
      ((env.RESEND_API_KEY ?? "").trim() === "" || (env.OWNER_EMAIL ?? "").trim() === "")
    ) {
      failed.push("mail");
    }
    const r = { passed: total - failed.length, total, failed };
    health.selfCheck = { atMs: nowMs(), ...r };
    say(
      `clock: selfcheck ${r.passed}/${r.total} passed${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`,
    );
    return r;
  }

  async function recover(): Promise<number> {
    try {
      const dead = await recoverStaleRows(leaseDb, nowMs());
      if (dead.length > 0) say(`clock: ${dead.length} run(s) of a dead runner marked failed`);
      // N3: a job cut off by a container stop or crash is a failure the Owner should hear about, like any other
      for (const d of dead) {
        await failureNotify({ job: d.job, runId: d.id, status: "failed", exitCode: null }).catch(
          () => {},
        );
      }
      return dead.length;
    } catch {
      return 0;
    }
  }

  const monitor = createMonitor({
    env,
    runtime,
    health,
    db: leaseDb,
    nowMs,
    fetch: realFetch,
    log: say,
    notify: (a) => sendAlertEmail(env, a, realFetch, nowMs()),
  });

  return {
    tick,
    runner,
    health,
    fetch: fetchShim,
    leaseDb,
    env: built.env,
    enqueue,
    selfCheck,
    recover,
    monitor,
  };
}

export { healthBody };
