// Shared names and parsing for the approved-commit watchdog (SEC-108 d): used by the route
// handler (writer) and System Health (reader). No I/O.
export const WATCHDOG_JOB = "watchdog-approved-commit";

export type WatchdogStatus = "ok" | "awaiting_first_approval" | "mismatch" | "unknown";

const STATUSES: readonly string[] = ["ok", "awaiting_first_approval", "mismatch", "unknown"];
const SHA40 = /^[0-9a-f]{40}$/;

export type ParsedWatchdog = {
  status: WatchdogStatus;
  approvedSha: string | null;
  deployedSha: string | null;
};

/** Reads a run record's details_json; anything unexpected becomes status "unknown". */
export function parseWatchdogDetails(details: unknown): ParsedWatchdog {
  const d =
    typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
  const sha = (v: unknown) => (typeof v === "string" && SHA40.test(v) ? v : null);
  return {
    status:
      typeof d.status === "string" && STATUSES.includes(d.status)
        ? (d.status as WatchdogStatus)
        : "unknown",
    approvedSha: sha(d.approvedSha),
    deployedSha: sha(d.deployedSha),
  };
}

export const shortSha = (sha: string | null): string | null => (sha ? sha.slice(0, 7) : null);
