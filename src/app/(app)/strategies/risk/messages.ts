// Result codes of the pause / kill action and the plain text shown for each (UX-050). No internals.
export type ControlResult = { ok: true } | { error: string };

export const CONTROL_ERROR_TEXT: Record<string, string> = {
  invalid: "Please check the entries and try again.",
  forbidden: "Only the Owner can pause or switch off a strategy.",
  confirmation_required: "Please confirm first.",
  not_found: "That strategy or family no longer exists. Reload the page.",
  no_change: "It is already in that state. Reload the page.",
  market_data_only:
    "The market is in data-only mode (no strategies are trading), so nothing can be paused or switched off yet.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const controlErrorText = (code: string): string =>
  CONTROL_ERROR_TEXT[code] ?? CONTROL_ERROR_TEXT.unavailable!;
