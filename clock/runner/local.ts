// Local job runner of praxis-clock (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5.3). It replaces a GitHub
// Actions run: the steps of one job from `deploy/selfhost/jobs.json` run one after another in a fresh
// per-run directory (`$W` = <root>/run-<id>), each with only the env variables the manifest hands to that
// step. Rules:
//  - Lease: a row in `job_run` (lease.ts). The run starts only when its concurrency group is free; a job
//    that cannot start waits in a queue (retried by `pump()` every clock tick) and is dropped as `skipped`
//    after `maxWaitMs`. The heartbeat runs every 30 s while the job runs.
//  - Timeout: SIGTERM at the job's limit, SIGKILL `graceMs` (30 s) later, status `timeout`.
//  - No retries here: the clock's own `recheck` and `maxAttempts` rules decide whether to start again.
//  - Logs: every line of stdout and stderr is masked (mask.ts) and goes to the log file and to the console.
//  - Failure (`failed`, `timeout`): the failure email (notify.ts), pointing to `praxis run logs <id>`.
//  - Scratch directories older than 3 days and logs older than 14 days are pruned.
import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import { sydneyLocal } from "../../worker/src/localtime";
import {
  blockingJobs,
  getJob,
  conditionHolds,
  resolveSource,
  tokenize,
  type Manifest,
  type SourceCtx,
  type StepOutcome,
} from "../manifest";
import {
  acquire,
  finish,
  heartbeat,
  HEARTBEAT_MS,
  LEASE_STALE_MS,
  recordSkipped,
  setLogPath,
  type LeaseDb,
  type RunStatus,
} from "../lease";
import { makeMasker, type Masker } from "../mask";
import type { FailureInfo } from "../notify";

export const GRACE_MS = 30_000;
export const MAX_WAIT_MS = 60 * 60_000;
export const SCRATCH_KEEP_MS = 3 * 86_400_000;
export const LOG_KEEP_MS = 14 * 86_400_000;

/** Variables every step gets (no secrets). Anything else must come from the step's own `env`. */
export const BASE_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PYTHONUNBUFFERED",
  "PYTHONDONTWRITEBYTECODE",
  "PRAXIS_RUNTIME",
  "SystemRoot",
];

export type RunRequest = {
  job: string;
  slotId?: string | null;
  inputs?: Record<string, string>;
};
export type RunResult = {
  id: number | null;
  status: RunStatus | "blocked" | "unknown-job";
  exitCode: number | null;
};
export type RunningInfo = { id: number; job: string; startedAt: string };

export type RunnerOptions = {
  manifest: Manifest;
  /** The clock's environment (jobs.env). Never passed whole to a step. */
  env: Readonly<Record<string, string | undefined>>;
  db: LeaseDb;
  /** Host directory of scratch dirs and logs (`/srv/praxis/jobs`). */
  root: string;
  /** Working directory of every command (the repository root inside the image). */
  cwd?: string;
  now?: () => number;
  /** Console sink; receives masked lines only. */
  log?: (line: string) => void;
  mask?: Masker;
  notify?: (info: FailureInfo) => Promise<unknown>;
  heartbeatMs?: number;
  graceMs?: number;
  staleMs?: number;
  maxWaitMs?: number;
};

type Queued = { req: RunRequest; at: number };

const SAFE_INPUT = /^[a-z_]+$/;

export class LocalRunner {
  private readonly o: Required<
    Pick<RunnerOptions, "manifest" | "env" | "db" | "root" | "cwd" | "now" | "log" | "mask">
  > &
    RunnerOptions;
  private queue: Queued[] = [];
  private readonly active = new Map<
    number,
    { job: string; startedAt: string; done: Promise<RunResult> }
  >();
  private pumping = false;

  constructor(opts: RunnerOptions) {
    this.o = {
      ...opts,
      cwd: opts.cwd ?? process.cwd(),
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      mask: opts.mask ?? makeMasker(opts.env),
    };
  }

  // ---- queue --------------------------------------------------------------------------------------------
  /** Queues a run (the clock's dispatch). The same job with the same inputs already waiting is a duplicate. */
  enqueue(req: RunRequest): "queued" | "duplicate" | "unknown-job" {
    if (getJob(this.o.manifest, req.job) === undefined) return "unknown-job";
    const key = JSON.stringify([req.job, sortedInputs(req.inputs)]);
    if (this.queue.some((q) => JSON.stringify([q.req.job, sortedInputs(q.req.inputs)]) === key)) {
      return "duplicate";
    }
    this.queue.push({ req, at: this.o.now() });
    void this.pump();
    return "queued";
  }

  queued(): { job: string; waitingSince: string }[] {
    return this.queue.map((q) => ({ job: q.req.job, waitingSince: new Date(q.at).toISOString() }));
  }

  /** Starts every queued run whose lease is free; drops runs that waited too long. Never throws. */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const item of [...this.queue]) {
        const now = this.o.now();
        if (now - item.at > (this.o.maxWaitMs ?? MAX_WAIT_MS)) {
          this.queue = this.queue.filter((q) => q !== item);
          this.line(`${item.req.job}: dropped, the lease stayed busy`);
          try {
            await recordSkipped(this.o.db, {
              job: item.req.job,
              slotId: item.req.slotId ?? null,
              localDate: sydneyLocal(now).date,
              nowMs: now,
            });
          } catch {
            // the row is a courtesy; the log line above stays
          }
          continue;
        }
        let id: number | null;
        try {
          id = await this.tryAcquire(item.req);
        } catch {
          this.line(`${item.req.job}: lease check failed (database), will retry`);
          continue;
        }
        if (id === null) continue;
        this.queue = this.queue.filter((q) => q !== item);
        this.start(id, item.req);
      }
    } finally {
      this.pumping = false;
    }
  }

  // ---- direct run (the CLI) -----------------------------------------------------------------------------
  /** Runs now and waits; `blocked` when the lease is held (the CLI tells the Owner). */
  async runNow(req: RunRequest): Promise<RunResult> {
    if (getJob(this.o.manifest, req.job) === undefined)
      return { id: null, status: "unknown-job", exitCode: null };
    const id = await this.tryAcquire(req);
    if (id === null) return { id: null, status: "blocked", exitCode: null };
    return this.start(id, req);
  }

  running(): RunningInfo[] {
    return [...this.active].map(([id, a]) => ({ id, job: a.job, startedAt: a.startedAt }));
  }

  /** Resolves when everything that runs now has finished (shutdown and tests). */
  async idle(): Promise<void> {
    while (this.active.size > 0)
      await Promise.allSettled([...this.active.values()].map((a) => a.done));
  }

  // ---- internals ----------------------------------------------------------------------------------------
  private line(s: string): void {
    this.o.log(this.o.mask(`clock: ${s}`));
  }

  private async tryAcquire(req: RunRequest): Promise<number | null> {
    const now = this.o.now();
    return acquire(this.o.db, {
      job: req.job,
      slotId: req.slotId ?? null,
      localDate: sydneyLocal(now).date,
      blocking: blockingJobs(this.o.manifest, req.job),
      nowMs: now,
      staleMs: this.o.staleMs ?? LEASE_STALE_MS,
    });
  }

  private start(id: number, req: RunRequest): Promise<RunResult> {
    const startedAt = new Date(this.o.now()).toISOString();
    const done = this.execute(id, req).finally(() => {
      this.active.delete(id);
      void this.pump(); // the group may be free now
    });
    this.active.set(id, { job: req.job, startedAt, done });
    return done;
  }

  private async execute(id: number, req: RunRequest): Promise<RunResult> {
    const job = getJob(this.o.manifest, req.job)!;
    const dir = path.join(this.o.root, `run-${id}`);
    const logDir = path.join(this.o.root, "logs");
    const logPath = path.join(logDir, `${id}-${req.job}.log`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    const out: WriteStream = createWriteStream(logPath, { flags: "a" });
    const tag = `[${req.job}#${id}]`;
    const emit = (raw: string): void => {
      const masked = this.o.mask(raw);
      out.write(masked + "\n");
      this.o.log(`${tag} ${masked}`);
    };
    try {
      await setLogPath(this.o.db, id, logPath);
    } catch {
      // the row keeps a NULL log_path; the file still exists
    }
    emit(
      `start ${req.job} (${"workflow" in job ? `workflow ${String(job.workflow)}` : "local job"})`,
    );

    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.inputs ?? {}))
      if (SAFE_INPUT.test(k)) inputs[k] = String(v);
    const outputs: Record<string, Record<string, string>> = {};
    const outcomes: Record<string, StepOutcome> = {};

    let timedOut = false;
    let child: ChildProcess | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const limitMs = job.timeoutMin * 60_000;
    const limitTimer = setTimeout(() => {
      timedOut = true;
      emit(`timeout after ${job.timeoutMin} min: sending SIGTERM`);
      if (child) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          emit(
            `still running ${(this.o.graceMs ?? GRACE_MS) / 1000} s after SIGTERM: sending SIGKILL`,
          );
          child?.kill("SIGKILL");
        }, this.o.graceMs ?? GRACE_MS);
      }
    }, limitMs);
    const hbTimer = setInterval(() => {
      heartbeat(this.o.db, id, this.o.now()).then(
        (alive) => {
          if (!alive) emit("heartbeat: this run is no longer marked running");
        },
        () => emit("heartbeat failed (database); will try again"),
      );
    }, this.o.heartbeatMs ?? HEARTBEAT_MS);

    let failed = false;
    let standby = false;
    let exitCode: number | null = 0;
    try {
      for (let i = 0; i < job.steps.length; i++) {
        const step = job.steps[i]!;
        const sid = step.id ?? `s${i + 1}`;
        if (timedOut) break;
        if (failed && !step.always) {
          outcomes[sid] = "skipped";
          continue;
        }
        if (step.if !== undefined && !conditionHolds(step.if, outputs, outcomes)) {
          outcomes[sid] = "skipped";
          emit(`step ${sid}: skipped (condition not met)`);
          continue;
        }
        const ctx: SourceCtx = { env: this.o.env, inputs, outputs };
        const stepEnv: Record<string, string> = {};
        for (const [name, src] of Object.entries(step.env ?? {})) {
          const v = resolveSource(name, src, ctx);
          if (v !== undefined) stepEnv[name] = v;
        }
        const outFile = path.join(dir, `out-${sid}.txt`);
        const env = {} as NodeJS.ProcessEnv;
        for (const n of BASE_ENV_NAMES) {
          const v = this.o.env[n] ?? process.env[n];
          if (v !== undefined) env[n] = v;
        }
        Object.assign(env, stepEnv, { W: dir, GITHUB_OUTPUT: outFile });
        let argv: string[];
        try {
          argv = tokenize(step.run, { ...stepEnv, W: dir });
        } catch (e) {
          emit(`step ${sid}: bad command (${e instanceof Error ? e.message : "error"})`);
          outcomes[sid] = "failure";
          failed = true;
          exitCode = 2;
          continue;
        }
        emit(`step ${sid}: ${argv[0] ?? ""} ${argv.slice(1).join(" ")}`);
        const code = await new Promise<number | null>((resolve) => {
          const c = spawn(argv[0]!, argv.slice(1), {
            cwd: this.o.cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          child = c;
          lineSplit(c.stdout!, emit);
          lineSplit(c.stderr!, emit);
          c.once("error", (err: NodeJS.ErrnoException) => {
            emit(`step ${sid}: could not start (${err.code ?? "error"})`);
            resolve(127);
          });
          c.once("close", (code2, signal) => resolve(signal ? null : code2));
        });
        child = null;
        if (killTimer) clearTimeout(killTimer);
        outputs[sid] = readOutputs(outFile);
        if (code === 0 || (code !== null && (job.okExitCodes ?? []).includes(code))) {
          outcomes[sid] = "success";
        } else if (code !== null && (job.standbyExitCodes ?? []).includes(code)) {
          // a guard refused: nothing was done, nothing to alert (e.g. turso-refresh while the cloud owns the data)
          outcomes[sid] = "skipped";
          standby = true;
          exitCode = code;
          emit(`step ${sid}: exit code ${code} (standby: refused by a guard, nothing was changed)`);
          break;
        } else {
          outcomes[sid] = "failure";
          failed = true;
          exitCode = code;
          emit(`step ${sid}: ${code === null ? "killed by signal" : `exit code ${code}`}`);
        }
      }
    } finally {
      clearTimeout(limitTimer);
      if (killTimer) clearTimeout(killTimer);
      clearInterval(hbTimer);
    }

    const status: Exclude<RunStatus, "running" | "skipped"> = timedOut
      ? "timeout"
      : failed
        ? "failed"
        : standby
          ? "standby"
          : "success";
    if ((status === "failed" || status === "timeout") && exitCode === 0) exitCode = null;
    emit(`end ${status}${exitCode === null ? "" : ` (exit code ${exitCode})`}`);
    await new Promise<void>((r) => out.end(r));
    try {
      await finish(this.o.db, id, status, exitCode, this.o.now());
    } catch {
      this.line(`${req.job}#${id}: could not record the end (database); the row will go stale`);
    }
    if ((status === "failed" || status === "timeout") && this.o.notify) {
      try {
        await this.o.notify({ job: req.job, runId: id, status, exitCode });
      } catch {
        // the alert path never disturbs the runner
      }
    }
    this.prune();
    return { id, status, exitCode };
  }

  /** Removes scratch dirs older than 3 days and logs older than 14 days. Returns how many it removed. */
  prune(): number {
    const now = this.o.now();
    let n = 0;
    const sweep = (dir: string, re: RegExp, keepMs: number): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (!re.test(name)) continue;
        const p = path.join(dir, name);
        try {
          if (now - statSync(p).mtimeMs > keepMs) {
            rmSync(p, { recursive: true, force: true });
            n++;
          }
        } catch {
          // another process may have removed it
        }
      }
    };
    sweep(this.o.root, /^run-\d+$/, SCRATCH_KEEP_MS);
    sweep(path.join(this.o.root, "logs"), /^\d+-[a-z0-9-]+\.log$/, LOG_KEEP_MS);
    return n;
  }
}

function sortedInputs(i: Record<string, string> | undefined): [string, string][] {
  return Object.entries(i ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/** `key=value` lines of a step's output file (the GITHUB_OUTPUT format the scripts already write). */
function readOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    // no output file: no outputs
  }
  return out;
}

function lineSplit(stream: NodeJS.ReadableStream, emit: (line: string) => void): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      emit(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  });
  stream.on("end", () => {
    if (buf !== "") emit(buf.replace(/\r$/, ""));
    buf = "";
  });
}
