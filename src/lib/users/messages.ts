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
  risk_not_acknowledged: "Tick the box to accept the risk first.",
  source_pending:
    "That source has not been accepted yet. Accept its risk first (the source must show Enabled).",
  calendar_unconfirmed: "Confirm the AU trading calendar first.",
  not_available: "That option is not available yet.",
  unavailable: "Something went wrong. Please try again.",
};

export const errorText = (code: string): string => ERROR_TEXT[code] ?? ERROR_TEXT.unavailable;
