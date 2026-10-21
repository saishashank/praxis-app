// Error codes returned by the Users & roles actions, and the text shown for each. No internals.
export type ActionResult = { ok: true } | { error: string };

export const ERROR_TEXT: Record<string, string> = {
  invalid: "Please check the entries and try again.",
  forbidden: "You do not have access to do that.",
  ack_required: "Acknowledge sharing first.",
  exists: "That address is already on the list.",
  not_found: "That user no longer exists.",
  owner_protected: "The Owner cannot be changed here.",
  revoked: "That user's access is already revoked.",
  grant_exists: "That user already has an unmask grant that has not expired.",
  risk_not_acknowledged: "Tick the box to accept the risk first.",
  source_pending:
    "That source has not been accepted yet. Accept its risk first (the source must show Enabled).",
  calendar_unconfirmed: "Confirm the AU trading calendar first.",
  not_available: "That option is not available yet.",
  data_only_market:
    "Full email stays off while a market is in data-only mode (until go-live). Choose incidents only.",
  email_mode_required: "The review test date needs the email mode set to incidents only first.",
  signoff_required:
    "Full mode needs the go-live sign-off first. Sign off on the Go-live page, then try again.",
  email_off: "Turn the email mode to incidents only before switching to full mode.",
  market_full:
    "Email cannot be switched off while a market is in full mode. Set the market back to data-only first.",
  confirm_required: "Confirm first: type the exact words or tick the confirmation box.",
  items_missing: "Tick every item on the checklist first.",
  commit_unknown: "The release commit could not be read. Enter it (7 to 64 letters and digits).",
  unknown_code: "That code is not a listed share of this market.",
  already_listed: "That code is already on your watch-list.",
  item_not_found: "That item is no longer listed. Reload the page.",
  snooze_red: "A red item cannot be snoozed. Fix it instead.",
  snooze_deadline: "An item within 2 days of its deadline cannot be snoozed.",
  unavailable: "Something went wrong. Please try again.",
};

export const errorText = (code: string): string => ERROR_TEXT[code] ?? ERROR_TEXT.unavailable;
