// INFRA T1 (INFRA §6): the single-clock rule, app side. Mirror of worker/src/owner.ts.
// `worker_state.clock_owner` is "cloud" or "selfhost"; absent, unreadable or any other value means
// "cloud" (today's behaviour). This app knows its own runtime from PRAXIS_RUNTIME (unset = "cloud").
// The cron handlers (heartbeat, watchdog) answer 200 `{ ok: true, standby: true }` and do nothing
// else when the owner names the other runtime.
import type { Client } from "@libsql/client";

export const CLOCK_OWNER_KEY = "clock_owner";

export type Runtime = "cloud" | "selfhost";
type OwnerEnv = Record<string, string | undefined>;

/** This runtime: "selfhost" only when PRAXIS_RUNTIME says so; everything else is "cloud". */
export function runtimeOf(env: OwnerEnv): Runtime {
  return (env.PRAXIS_RUNTIME ?? "").trim().toLowerCase() === "selfhost" ? "selfhost" : "cloud";
}

/** The owner from a stored `value_json` (a JSON string); anything but "selfhost" is "cloud". */
export function ownerFrom(valueJson: string | null | undefined): Runtime {
  if (valueJson === undefined || valueJson === null) return "cloud";
  try {
    return JSON.parse(valueJson) === "selfhost" ? "selfhost" : "cloud";
  } catch {
    return "cloud";
  }
}

export function isOwner(env: OwnerEnv, valueJson: string | null | undefined): boolean {
  return ownerFrom(valueJson) === runtimeOf(env);
}

/**
 * True when the main DB's `clock_owner` names the other runtime. One cheap primary-key read; a failed
 * read counts as "cloud" (so a cloud app never stands by because of an outage).
 */
export async function onStandby(db: Client, env: OwnerEnv): Promise<boolean> {
  let raw: string | null = null;
  try {
    const res = await db.execute({
      sql: "SELECT value_json FROM worker_state WHERE key = ?",
      args: [CLOCK_OWNER_KEY],
    });
    const v = res.rows[0]?.[0];
    raw = typeof v === "string" ? v : null;
  } catch {
    raw = null;
  }
  return !isOwner(env, raw);
}

export const STANDBY_BODY = { ok: true, standby: true } as const;
