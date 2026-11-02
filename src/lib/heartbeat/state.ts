// Shared names for the independent heartbeat (PLT-074): used by the route handlers (writers),
// the checks and System Health (reader). No I/O.
export const HEARTBEAT_MORNING_JOB = "heartbeat-morning";
export const HEARTBEAT_EVENING_JOB = "heartbeat-evening";
/** The Worker's own daily rollup run record (worker/src/clock.ts `CLOCK_JOB`). */
export const WORKER_CLOCK_JOB = "worker-clock";

export type HeartbeatKind = "morning" | "evening";

export const heartbeatJob = (kind: HeartbeatKind): string =>
  kind === "morning" ? HEARTBEAT_MORNING_JOB : HEARTBEAT_EVENING_JOB;

/** Incident kinds the heartbeat can open (all S2, one open incident per kind). */
export const KIND_WORKER_BLIND = "worker_blind";
export const KIND_SENTINEL_BLIND = "sentinel_blind";
export const KIND_MARKER_MISSING = "completion_marker_missing";
/** V1-S3 / D-712: a weekday with no trading_calendar row, or the calendar ends within 60 days. */
export const KIND_CALENDAR_MISSING = "calendar_missing";
export const KIND_CALENDAR_HORIZON = "calendar_horizon";
/** R2-S1 / D-802: last night's evening heartbeat left no final record (seen by the morning check). */
export const KIND_EVENING_HEARTBEAT_MISSING = "evening_heartbeat_missing";
