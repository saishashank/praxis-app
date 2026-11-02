// Result codes of the Ops tick action and the plain text shown for each (UX-118). No internals.
export type TickResult = { ok: true } | { error: string };

export const TICK_ERROR_TEXT: Record<string, string> = {
  invalid: "Please reload the page and try again.",
  forbidden: "Only the Owner can tick Ops tasks.",
  unknown_task: "That task is no longer on the list. Reload the page.",
  not_due: "That task has a new due date. Reload the page.",
  already_done: "That task is already ticked. Reload the page.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const tickErrorText = (code: string): string =>
  TICK_ERROR_TEXT[code] ?? TICK_ERROR_TEXT.unavailable!;

// ---- Run now (D-840..D-849) ---------------------------------------------------------------------
export type RunNowResult = { ok: true } | { error: string };

export const RUN_NOW_ERROR_TEXT: Record<string, string> = {
  invalid: "That date is not allowed. Pick a day from the list and try again.",
  forbidden: "Only the Owner can run a job now.",
  unknown_job: "That job cannot be run by hand. Reload the page.",
  confirm_required: "Please confirm first.",
  already_pending: "A request for this job is already waiting. Please wait for it to finish.",
  rate_limited: "Too many requests for this job in the last hour. Try again later.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const runNowErrorText = (code: string): string =>
  RUN_NOW_ERROR_TEXT[code] ?? RUN_NOW_ERROR_TEXT.unavailable!;

const REFUSED_TEXT: Record<string, string> = {
  "not listed": "the job is not on your list of jobs that may run",
  "dispatch is off": "the dispatch switch is off",
  "market is off": "the market is switched off",
  "not a trading day": "that day is not a trading day",
  "nothing is due": "nothing is due yet",
  "attempt 1 already worked": "the first attempt already worked",
  "inputs missing": "its settings are missing",
  "unknown job": "this job cannot be run by hand",
  "bad request": "the request was not valid",
  "not available": "the job is not available",
};

/** The plain-words outcome of the newest manual request of a job (what the Worker recorded). */
export function runNowOutcomeText(status: string, result: string | null): string {
  if (status === "pending") return "Waiting. The Worker picks it up within a minute.";
  if (status === "dispatched") return "Starting now.";
  if (status === "expired") return "Not run. It waited more than 30 minutes.";
  const r = result ?? "";
  if (r.startsWith("started:")) return "Started. The job does its own work and checks.";
  if (r.startsWith("ran:")) return "Ran.";
  if (r.startsWith("failed:")) return `Failed (${r.slice(7).trim() || "no detail"}).`;
  if (r.startsWith("refused:")) {
    const why = r.slice(8).trim();
    return `Not run: ${REFUSED_TEXT[why] ?? "a safety check said no"}.`;
  }
  return "Finished.";
}
