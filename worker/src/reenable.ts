// PLT-015 daily re-enable (M8 T8; TST-112a; D-060, D-056). HIGH-RISK: it holds the GitHub token with
// Actions write and writes to the production database.
//
// Spec text this file implements (02_platform_hosting_auth.md:26 PLT-015): "In a **public** repo
// GitHub **disables scheduled workflows after 60 days without repository activity**. Therefore:
// Worker-dispatched workflows have no `schedule:` trigger (`workflow_dispatch` only); the YAML
// backup-trigger and watchdog workflows are the only scheduled ones; the Worker checks their state
// daily (token b, actions read/write), **re-enables** any that GitHub disabled and raises an in-app
// notice each time ... [VERIFY that dispatch-only workflows are unaffected]".
//
// How it works:
//  - Once a day, on the UTC ticks 02:40..02:44 (after the 02:15 self-check; five ticks so a failed
//    attempt is retried), and only then. Every other minute: no work, no request, no log.
//  - The day's attempt is claimed in `worker_state` (`reenable:<local date>`, same conditional-write
//    claim as the clock slots, PLT-076): racing isolates run it once; at most 3 attempts a day.
//  - GitHub: list the workflows; for each one in state `disabled_inactivity` read its file and
//    re-enable it ONLY if the file has a `schedule:` trigger. A dispatch-only workflow is never touched
//    (it is not subject to the 60-day rule; `disabled_manually` is the Owner's choice and also left alone).
//    At most MAX_PER_RUN workflows per run (subrequest budget, PLT-070: 50).
//  - Each re-enable is recorded as an in-app notice: an open S3 `incident` row (in-app only, never
//    an email) with short facts, and the run as a `worker-reenable` run record (failed if anything
//    failed). The notice is written by the Worker itself, with the read-write main-DB token it already
//    holds for the clock; no new route and no new secret.
//  - GitHub is reached through the injectable `WorkflowClient`; tests use a fake. Errors never escape
//    `runReenable` and carry only fixed words or an error NAME (never the token or a response body).
import { dbConfigured, pipeline, type Arg, type DbEnv, type Stmt } from "./db";
import { CODE_REPO, DISPATCH_TIMEOUT_MS, GITHUB_API_VERSION, refFor } from "./dispatch";
import { sydneyLocal } from "./localtime";
import { CLAIM_STALE_MS, MAX_ATTEMPTS, parseState, type SlotState } from "./clock";

export const REENABLE_JOB = "worker-reenable";
export const REENABLE_INCIDENT_KIND = "workflow_reenabled";
export const REENABLE_HOUR_UTC = 2;
export const REENABLE_FIRST_MINUTE_UTC = 40;
export const REENABLE_WINDOW_MIN = 5;
/** Workflows handled per run: 1 list + up to 2 GitHub calls each stays far below 50 subrequests. */
export const MAX_PER_RUN = 10;

export type WorkflowInfo = { id: number; path: string; state: string };

/** The GitHub operations the check needs. The default implementation is `githubWorkflowClient`. */
export interface WorkflowClient {
  list(): Promise<WorkflowInfo[]>;
  /** True when the workflow file has a `schedule:` trigger. */
  hasSchedule(path: string): Promise<boolean>;
  enable(id: number): Promise<void>;
}

export type ReenableEnv = DbEnv & { PRAXIS_ENV: string; GITHUB_DISPATCH_TOKEN?: string };
export type ReenableDeps = { fetch: typeof fetch; nowMs: () => number; client?: WorkflowClient };
export type ReenableSummary = {
  requests: number;
  checked: boolean;
  reenabled: string[];
  failed: string[];
  /** Disabled-by-inactivity workflows left alone because they have no `schedule:` trigger. */
  untouched: string[];
};

const iso = (ms: number) => new Date(ms).toISOString();
const errName = (e: unknown) => (e instanceof Error && e.name ? e.name.slice(0, 40) : "Error");
const WORKFLOW_PATH_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

export const reenableKey = (date: string): string => `reenable:${date}`;

/** True on the five UTC ticks of the daily check. */
export function isReenableTick(scheduledTime: number): boolean {
  const d = new Date(scheduledTime);
  const m = d.getUTCMinutes() - REENABLE_FIRST_MINUTE_UTC;
  return d.getUTCHours() === REENABLE_HOUR_UTC && m >= 0 && m < REENABLE_WINDOW_MIN;
}

/**
 * True when the YAML has a `schedule:` key directly under `on:` (two-space indent). Comment lines
 * and text inside values never count (the workflow headers mention `schedule:` in comments).
 */
export function hasScheduleTrigger(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/);
  let inOn = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    if (/^on:\s*(#.*)?$/.test(line)) {
      inOn = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inOn = false; // another top-level key
      continue;
    }
    if (inOn && /^ {2}schedule:\s*(#.*)?$/.test(line)) return true;
  }
  return false;
}

/** The real GitHub client: read-only list and file read, plus the one write (enable). */
export function githubWorkflowClient(env: ReenableEnv, f: typeof fetch): WorkflowClient {
  const base = `https://api.github.com/repos/${CODE_REPO}`;
  const headers = (accept: string): Record<string, string> => ({
    Authorization: `Bearer ${(env.GITHUB_DISPATCH_TOKEN ?? "").trim()}`,
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "praxis-sentinel-reenable",
  });
  const call = (url: string, method: string, accept: string) =>
    f(url, {
      method,
      headers: headers(accept),
      redirect: "manual",
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
  const fail = (what: string, status: number): never => {
    const e = new Error(`${what} HTTP ${status}`);
    e.name = `Http${status}`;
    throw e;
  };
  return {
    async list() {
      const res = await call(
        `${base}/actions/workflows?per_page=100`,
        "GET",
        "application/vnd.github+json",
      );
      if (res.status !== 200) return fail("list", res.status);
      const json = (await res.json()) as { workflows?: unknown };
      if (!Array.isArray(json.workflows)) return fail("list-shape", 200);
      const out: WorkflowInfo[] = [];
      for (const w of json.workflows as Record<string, unknown>[]) {
        if (
          typeof w?.id === "number" &&
          typeof w.path === "string" &&
          typeof w.state === "string"
        ) {
          out.push({ id: w.id, path: w.path, state: w.state });
        }
      }
      return out;
    },
    async hasSchedule(path) {
      if (!WORKFLOW_PATH_RE.test(path)) return false; // never build a URL from an odd path
      const res = await call(`${base}/contents/${path}`, "GET", "application/vnd.github.raw+json");
      if (res.status !== 200) return fail("file", res.status);
      return hasScheduleTrigger(await res.text());
    },
    async enable(id) {
      if (!Number.isInteger(id) || id <= 0) return fail("enable-id", 0);
      const res = await call(
        `${base}/actions/workflows/${id}/enable`,
        "PUT",
        "application/vnd.github+json",
      );
      if (res.status !== 204) fail("enable", res.status);
    },
  };
}

/** Never throws. No work (and no request) outside the five daily ticks. */
export async function runReenable(
  env: ReenableEnv,
  scheduledTime: number,
  deps: ReenableDeps,
): Promise<ReenableSummary> {
  const summary: ReenableSummary = {
    requests: 0,
    checked: false,
    reenabled: [],
    failed: [],
    untouched: [],
  };
  try {
    if (!isReenableTick(scheduledTime)) return summary;
    if (!dbConfigured(env) || refFor(env.PRAXIS_ENV) === null) return summary;
    if ((env.GITHUB_DISPATCH_TOKEN ?? "").trim() === "") return summary;
    const local = sydneyLocal(scheduledTime);
    const key = reenableKey(local.date);
    const nowMs = deps.nowMs();

    // ---- request 1: today's claim, if any -------------------------------------------------------
    let stored: { raw: string; state: SlotState | null } | undefined;
    try {
      summary.requests++;
      const [r] = await pipeline(
        env,
        [{ sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [key] }],
        deps.fetch,
      );
      const raw = r.rows[0]?.[0];
      if (raw !== undefined && raw !== null)
        stored = { raw: String(raw), state: parseState(String(raw)) };
    } catch (e) {
      console.log(`reenable: db error ${errName(e)}`);
      return summary;
    }
    let attempt = 1;
    let prev: string | null = null;
    if (stored !== undefined) {
      const st = stored.state;
      if (st === null || st.s === "dispatched") return summary; // done today, or unreadable: leave it
      const stale = st.s === "claimed" && nowMs - Date.parse(st.at) >= CLAIM_STALE_MS;
      if (!((st.s === "failed" || stale) && st.n < MAX_ATTEMPTS)) return summary;
      attempt = st.n + 1;
      prev = stored.raw;
    }

    // ---- request 2: claim (1 changed row = this isolate owns the attempt) ------------------------
    const claimAt = iso(deps.nowMs());
    const claimed = JSON.stringify({ s: "claimed", n: attempt, at: claimAt } satisfies SlotState);
    try {
      summary.requests++;
      const [c] = await pipeline(
        env,
        [
          prev === null
            ? {
                sql:
                  "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
                  "ON CONFLICT (key) DO NOTHING",
                args: [key, claimed, claimAt],
              }
            : {
                sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ? AND value_json = ?",
                args: [claimed, claimAt, key, prev],
              },
        ],
        deps.fetch,
      );
      if (c.affected !== 1) return summary;
    } catch (e) {
      console.log(`reenable: db error ${errName(e)}`);
      return summary;
    }

    // ---- GitHub ------------------------------------------------------------------------------
    summary.checked = true;
    const client = deps.client ?? githubWorkflowClient(env, deps.fetch);
    let listError: string | null = null;
    const detail: { path: string; id: number }[] = [];
    try {
      const all = await client.list();
      const disabled = all.filter((w) => w.state === "disabled_inactivity").slice(0, MAX_PER_RUN);
      for (const w of disabled) {
        try {
          if (!(await client.hasSchedule(w.path))) {
            summary.untouched.push(w.path);
            continue; // dispatch-only: not affected by the 60-day rule, never touched
          }
          await client.enable(w.id);
          summary.reenabled.push(w.path);
          detail.push({ path: w.path, id: w.id });
          console.log("reenable: re-enabled a scheduled workflow");
        } catch (e) {
          summary.failed.push(w.path);
          console.log(`reenable: workflow error ${errName(e)}`);
        }
      }
    } catch (e) {
      listError = errName(e);
      console.log(`reenable: github error ${listError}`);
    }
    const ok = listError === null && summary.failed.length === 0;

    // ---- request 3: result, notices, run record -------------------------------------------------
    const at = iso(deps.nowMs());
    const record: Stmt[] = [
      {
        sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ?",
        args: [JSON.stringify({ s: ok ? "dispatched" : "failed", n: attempt, at }), at, key],
      },
    ];
    for (const d of detail) {
      record.push({
        sql: "INSERT INTO incident (at, severity, kind, detail_json) VALUES (?, 'S3', ?, ?)",
        args: [
          at,
          REENABLE_INCIDENT_KIND,
          JSON.stringify({
            summary:
              "GitHub disabled a scheduled workflow after 60 days without activity; it was re-enabled",
            component: "Scheduling",
            workflow: d.path.slice(0, 80),
            impact:
              "The YAML backup schedule was paused until now; the Worker clock was not affected.",
            fix: "No action needed. Repository activity keeps schedules from being disabled again.",
            fixPath: "/health",
          }),
        ],
      });
    }
    const args: Arg[] = [
      REENABLE_JOB,
      `${REENABLE_JOB}:${local.date}:${attempt}`,
      local.date,
      at,
      at,
      ok ? "success" : "failed",
      detail.length,
      ok ? null : `reenable ${listError ?? `${summary.failed.length} failed`}`.slice(0, 120),
      JSON.stringify({
        reenabled: summary.reenabled.length,
        untouched: summary.untouched.length,
        failed: summary.failed.length,
        attempt,
      }),
    ];
    record.push({
      sql:
        "INSERT INTO run_record (job, concurrency_key, scheduled_for, started_at, ended_at, status, " +
        "items_processed, error_summary, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (concurrency_key) WHERE status = 'success' DO NOTHING",
      args,
    });
    for (let tries = 0; tries < 2; tries++) {
      try {
        summary.requests++;
        await pipeline(env, record, deps.fetch);
        break;
      } catch (e) {
        console.log(`reenable: record error ${errName(e)}`);
      }
    }
  } catch (e) {
    console.log(`reenable: error ${errName(e)}`);
  }
  return summary;
}
