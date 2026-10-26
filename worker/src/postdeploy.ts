// Post-deploy fill (D-195, Owner 2026-10-26: "when the fix gets deployed the once off polling
// happens"). The deploy sets BUILD_COMMIT on this Worker; the first tick of a new commit dispatches,
// once, the jobs that fill the data a release can use at once: asx-fetch.yml with the history fill
// and replay.yml in mode full. This replaces a GitHub `workflow_run` trigger (CodeQL: checkout in a
// privileged workflow_run context): the clock stays the one scheduler (PLT-071) and dispatches
// through its own allow-list and token (./dispatch.ts).
//
// Once per commit: a `postdeploy:<commit>` row in worker_state is claimed with a conditional write
// (one changed row = this tick owns it); the outcome is written back. A failed dispatch is tried
// again on a later tick, at most MAX_ATTEMPTS times. Inert unless production with the database,
// the dispatch switch on and a valid BUILD_COMMIT. After the commit is done, an in-isolate note
// keeps every later tick free of any request.
import { DISPATCH_ENABLED_KEY, parseEnabled } from "./clock";
import { dbConfigured, pipeline, type DbEnv } from "./db";
import { dispatchWorkflow, type DispatchEnv } from "./dispatch";

export const POSTDEPLOY_JOBS: readonly { workflow: string; inputs: Record<string, string> }[] = [
  { workflow: "asx-fetch.yml", inputs: { history: "true" } },
  { workflow: "replay.yml", inputs: { mode: "full" } },
];
export const MAX_ATTEMPTS = 3;
const COMMIT_RE = /^[0-9a-f]{40}$/;

export type PostDeployEnv = DbEnv & DispatchEnv & { BUILD_COMMIT?: string };
export type PostDeployDeps = { fetch: typeof fetch; nowMs: () => number };
type Stored = { s: "claimed" | "dispatched" | "failed"; n: number; at: string };

let doneFor: string | null = null;
/** Tests only: forget the in-isolate note. */
export function resetPostDeploy(): void {
  doneFor = null;
}

export const postDeployKey = (commit: string): string => `postdeploy:${commit}`;

/** Returns what happened, for tests and the log; never throws. */
export async function runPostDeploy(
  env: PostDeployEnv,
  deps: PostDeployDeps,
): Promise<"inert" | "done" | "not-enabled" | "not-owner" | "dispatched" | "failed"> {
  try {
    const commit = (env.BUILD_COMMIT ?? "").trim();
    if (env.PRAXIS_ENV !== "production" || !dbConfigured(env) || !COMMIT_RE.test(commit)) {
      return "inert";
    }
    if (doneFor === commit) return "done";
    const key = postDeployKey(commit);
    const [rows] = await pipeline(
      env,
      [
        {
          sql: "SELECT key, value_json FROM worker_state WHERE key IN (?, ?)",
          args: [DISPATCH_ENABLED_KEY, key],
        },
      ],
      deps.fetch,
    );
    let enabledRaw: string | undefined;
    let prev: string | null = null;
    for (const r of rows!.rows) {
      if (String(r[0]) === DISPATCH_ENABLED_KEY) enabledRaw = String(r[1]);
      else prev = String(r[1]);
    }
    if (!parseEnabled(enabledRaw)) return "not-enabled";
    let attempt = 1;
    if (prev !== null) {
      let st: Stored | null = null;
      try {
        st = JSON.parse(prev) as Stored;
      } catch {
        st = null;
      }
      if (st === null || st.s !== "failed" || st.n >= MAX_ATTEMPTS) {
        doneFor = commit; // dispatched, claimed by another tick, or out of attempts
        return "done";
      }
      attempt = st.n + 1;
    }
    const at = new Date(deps.nowMs()).toISOString();
    const claim = JSON.stringify({ s: "claimed", n: attempt, at } satisfies Stored);
    const [claimed] = await pipeline(
      env,
      [
        prev === null
          ? {
              sql:
                "INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, ?) " +
                "ON CONFLICT (key) DO NOTHING",
              args: [key, claim, at],
            }
          : {
              sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ? AND value_json = ?",
              args: [claim, at, key, prev],
            },
      ],
      deps.fetch,
    );
    if (claimed!.affected !== 1) return "not-owner";
    let ok = true;
    for (const job of POSTDEPLOY_JOBS) {
      // `commit`: the job waits until this commit is the approved deploy (D-197). The Worker is
      // deployed inside the deploy job, before GitHub marks the deployment a success.
      const res = await dispatchWorkflow(env, job.workflow, deps.fetch, { ...job.inputs, commit });
      console.log(`postdeploy: ${job.workflow} ${res.ok ? "dispatched" : `failed ${res.detail}`}`);
      ok &&= res.ok;
    }
    const done = new Date(deps.nowMs()).toISOString();
    const st: Stored = { s: ok ? "dispatched" : "failed", n: attempt, at: done };
    await pipeline(
      env,
      [
        {
          sql: "UPDATE worker_state SET value_json = ?, updated_at = ? WHERE key = ?",
          args: [JSON.stringify(st), done, key],
        },
      ],
      deps.fetch,
    );
    if (ok || attempt >= MAX_ATTEMPTS) doneFor = commit;
    return ok ? "dispatched" : "failed";
  } catch (e) {
    console.log(`postdeploy: error ${e instanceof Error ? e.name : "unknown"}`);
    return "failed";
  }
}
