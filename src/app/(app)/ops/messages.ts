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
