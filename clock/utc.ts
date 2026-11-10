// Runs the UTC crons that are due in one minute (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §2.3, §4; crons.ts).
// Owner gate first: one read of `worker_state.clock_owner` (only on a minute that has a cron due, so an idle
// minute costs nothing); when the key does not name this runtime, or cannot be read, nothing fires.
import { pipeline } from "../worker/src/db";
import { CLOCK_OWNER_KEY, isOwner, standbyLine } from "../worker/src/owner";
import { sydneyLocal } from "../worker/src/localtime";
import { backstopDecision, utcCronsDue, type UtcCron } from "./crons";
import type { TickEnv } from "./env";
import type { RunRequest } from "./runner/local";

export const CRON_TIMEOUT_MS = 28_000;
export const CRON_USER_AGENT = "vercel-cron/1.0 (praxis-clock)";

export type UtcDeps = {
  fetch: typeof fetch;
  nowMs: () => number;
  /** Queues a local job (the GitHub backstops). */
  enqueue: (req: RunRequest) => "queued" | "duplicate" | "unknown-job";
  log: (line: string) => void;
  /** The real CRON_SECRET and app origin (not the https stand-in the Worker runners use). */
  cronSecret: string | undefined;
};

export type UtcSummary = {
  /** Ids of crons that fired (route called or job queued). */
  fired: string[];
  /** Ids of backstops the DST gate stood down (the other regime's line). */
  gated: string[];
  failed: string[];
  standby: boolean;
};

/** GET of a Vercel cron route on the app. Never throws; true on HTTP 200. */
async function callRoute(env: TickEnv, path: string, deps: UtcDeps): Promise<boolean> {
  const base = (env.APP_BASE_URL ?? "").trim();
  const secret = (deps.cronSecret ?? "").trim();
  if (base === "" || secret === "") return false;
  try {
    const res = await deps.fetch(new URL(path, base).toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}`, "User-Agent": CRON_USER_AGENT },
      redirect: "manual",
      signal: AbortSignal.timeout(CRON_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Fires the crons due in the UTC minute that contains `ms`. Never throws. */
export async function runUtcCrons(env: TickEnv, ms: number, deps: UtcDeps): Promise<UtcSummary> {
  const summary: UtcSummary = { fired: [], gated: [], failed: [], standby: false };
  try {
    const due: UtcCron[] = utcCronsDue(ms);
    if (due.length === 0) return summary;
    let raw: string | undefined;
    try {
      const [r] = await pipeline(
        env,
        [{ sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [CLOCK_OWNER_KEY] }],
        deps.fetch,
      );
      const cell = r?.rows[0]?.[0];
      raw = cell === undefined || cell === null ? undefined : String(cell);
    } catch {
      deps.log("clock: utc crons skipped (owner unreadable)");
      summary.failed.push(...due.map((c) => c.id));
      return summary;
    }
    if (!isOwner(env, raw)) {
      deps.log(standbyLine(env, raw));
      summary.standby = true;
      return summary;
    }
    for (const c of due) {
      if (c.source === "vercel") {
        const ok = await callRoute(env, c.path, deps);
        (ok ? summary.fired : summary.failed).push(c.id);
        deps.log(`clock: cron ${c.id} ${ok ? "ok" : "failed"}`);
      } else {
        const d = backstopDecision(c, ms);
        if (!d.run) {
          summary.gated.push(c.id);
          continue;
        }
        const res = deps.enqueue({
          job: c.job,
          slotId: c.id,
          inputs: d.inputs,
        });
        deps.log(`clock: backstop ${c.id} -> ${c.job} (${res}, ${sydneyLocal(ms).date})`);
        (res === "unknown-job" ? summary.failed : summary.fired).push(c.id);
      }
    }
  } catch {
    // never throws
  }
  return summary;
}
