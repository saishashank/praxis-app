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
  not_frozen: "That cohort is not frozen any more. Reload the page.",
  gap_too_long:
    "Too many sessions were missed to replay here. Leave it frozen and ask the builder to replay them (runbook: ledger invariant).",
  catch_up_invariants_failed:
    "A missed session failed the ledger check again, so the cohort stays frozen. See the app log.",
  catch_up_blocked: "A missed session could not be replayed. Nothing was cleared; try again later.",
  catch_up_incomplete: "Not all missed sessions were replayed. Nothing was cleared; try again.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const controlErrorText = (code: string): string =>
  CONTROL_ERROR_TEXT[code] ?? CONTROL_ERROR_TEXT.unavailable!;
