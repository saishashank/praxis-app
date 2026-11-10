// UTC schedules the clock fires itself (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §2.3, §4, §6.2).
// Two groups, both fixed UTC times that the cloud runtime gets from other schedulers:
//  - the 8 Vercel crons of `vercel.json` (heartbeats and the Vercel watchdog): a GET to the same app route,
//    `Authorization: Bearer CRON_SECRET`, the Vercel user agent (the evening heartbeat accepts a scheduled
//    call by DST regime on that agent);
//  - the GitHub `schedule:` backstops of ingest-batch1.yml and watchdog.yml: local jobs, each behind the
//    same `scheduleGate` the workflow uses (`scripts/time/scheduleGate.mjs`: the line of the other DST
//    regime is a no-op).
// `nightly.yml` and `mutation.yml` are CI and stay on GitHub (INF-O2); they are not here.
// tests/selfhost/manifest-drift.test.ts compares this table with vercel.json and the workflow files.
import { gate } from "../scripts/time/scheduleGate.mjs";

export type UtcCron =
  | {
      id: string;
      source: "vercel";
      /** UTC "HH:MM", every day. */
      at: string;
      /** App route with its query string, exactly as in vercel.json. */
      path: string;
    }
  | {
      id: string;
      source: "github";
      at: string;
      /** The workflow's cron line, e.g. "15 7 * * *" (the input of scheduleGate). */
      cron: string;
      /** The clock job that mirrors the workflow. */
      job: string;
      /** The local times the workflow's gate step is given (`scheduleGate.mjs 20:40 21:50`). */
      gateTimes: string[];
    };

const v = (id: string, at: string, path: string): UtcCron => ({ id, source: "vercel", at, path });
const g = (id: string, at: string, job: string, gateTimes: string[]): UtcCron => {
  const [h, m] = at.split(":").map(Number);
  return { id, source: "github", at, cron: `${m} ${h} * * *`, job, gateTimes };
};

export const UTC_CRONS: readonly UtcCron[] = [
  v("heartbeat-morning-1", "00:20", "/api/cron/heartbeat-morning"),
  v("heartbeat-morning-2", "00:50", "/api/cron/heartbeat-morning?try=2"),
  v("heartbeat-evening-aedt-1", "10:10", "/api/cron/heartbeat-evening?dst=aedt"),
  v("heartbeat-evening-aedt-2", "10:40", "/api/cron/heartbeat-evening?dst=aedt&try=2"),
  v("heartbeat-evening-1", "11:10", "/api/cron/heartbeat-evening"),
  v("heartbeat-evening-2", "11:40", "/api/cron/heartbeat-evening?try=2"),
  v("watchdog-1", "11:40", "/api/cron/watchdog"),
  v("watchdog-2", "12:40", "/api/cron/watchdog?try=2"),
  g("ingest-batch1-backstop-1", "07:15", "ingest-batch1", ["18:15"]),
  g("ingest-batch1-backstop-2", "08:15", "ingest-batch1", ["18:15"]),
  g("watchdog-backstop-1", "09:40", "watchdog", ["20:40", "21:50"]),
  g("watchdog-backstop-2", "10:40", "watchdog", ["20:40", "21:50"]),
  g("watchdog-backstop-3", "10:50", "watchdog", ["20:40", "21:50"]),
  g("watchdog-backstop-4", "11:50", "watchdog", ["20:40", "21:50"]),
];

/** Minute of the UTC day, 0..1439, of an epoch ms. */
export const utcMinuteOfDay = (ms: number): number => Math.floor(ms / 60_000) % 1440;

const minuteOf = (at: string): number => Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5));

/** The crons due in the UTC minute that contains `ms` (pure). */
export function utcCronsDue(ms: number): UtcCron[] {
  const m = utcMinuteOfDay(ms);
  return UTC_CRONS.filter((c) => minuteOf(c.at) === m);
}

/**
 * What a due GitHub backstop does: run the job (with the `slot` input of the watchdog) or stand down,
 * exactly as the workflow's `gate` job decides. Vercel entries have no gate.
 */
export function backstopDecision(
  c: Extract<UtcCron, { source: "github" }>,
  ms: number,
): { run: boolean; inputs: Record<string, string> } {
  const d = gate(c.cron, ms, c.gateTimes) as { run: boolean; slot: string };
  if (!d.run) return { run: false, inputs: {} };
  return { run: true, inputs: d.slot !== "" && c.job === "watchdog" ? { slot: d.slot } : {} };
}
