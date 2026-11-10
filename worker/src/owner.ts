// INFRA T1 (INFRA §6): the single-clock rule. `worker_state.clock_owner` is `"cloud"` or `"selfhost"`.
// Absent, unreadable or any other value means "cloud", so shipping this changes nothing for the
// live system. Each runtime knows itself from `PRAXIS_RUNTIME` (unset or empty = "cloud") and acts
// only when the owner names it. The key rides in each runner's EXISTING worker_state read: no
// extra request and no extra read on an idle minute (decision O-81). Mirror: src/lib/runtime/owner.ts.
export const CLOCK_OWNER_KEY = "clock_owner";

export type Runtime = "cloud" | "selfhost";
export type OwnerEnv = { PRAXIS_RUNTIME?: string };

/** This runtime: "selfhost" only when set exactly so; everything else is "cloud". */
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

/** The one log line of a runtime that stands by (no secrets). */
export function standbyLine(env: OwnerEnv, valueJson: string | null | undefined): string {
  return `clock: standby (owner=${ownerFrom(valueJson)}, runtime=${runtimeOf(env)})`;
}

/**
 * SQL guard for a conditional write: true only while this runtime owns the clock. Same meaning as
 * `isOwner` (valid JSON string "selfhost" = selfhost, else cloud). One bind argument: CLOCK_OWNER_KEY.
 */
export function ownerGuardSql(env: OwnerEnv): string {
  const selfhost =
    "(SELECT 1 FROM worker_state WHERE key = ? AND json_valid(value_json) " +
    "AND json_extract(value_json, '$') = 'selfhost')";
  return runtimeOf(env) === "selfhost" ? `EXISTS ${selfhost}` : `NOT EXISTS ${selfhost}`;
}
