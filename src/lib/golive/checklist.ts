// The go-live checklist and the typed confirmation (M8 T11; docs/M8_design.md section 7 phase P6,
// decisions 24 and 33). Pure data, no server imports: the page, the action and the tests share it.
// Every item must be ticked before a sign-off row can be written (the server checks the full set;
// the page only mirrors it). Wording is plain English and names no secret value.

export type GoLiveItem = { readonly id: string; readonly label: string; readonly help: string };

export const GO_LIVE_ITEMS: readonly GoLiveItem[] = [
  {
    id: "pat_revoked",
    label: "The build bot and its key are gone",
    help: "AT-30, SEC-108 e. No one can change the code now. A new key is needed for that.",
  },
  {
    id: "tokens_rotated",
    label: "Every live secret is new and tested",
    help: "AT-30, SEC-021. The steps are in the go-live guide.",
  },
  {
    id: "restore_drill",
    label: "The restore test passed and its two keys are deleted",
    help: "AT-30, TST-108. Use the real key. The last step turns green once the keys are gone.",
  },
  {
    id: "zero_cost",
    label: "The $0 check is done on every provider",
    help: "AT-30: each provider shows no charge and no card on a paid plan.",
  },
  {
    id: "walkthrough",
    label: "You looked at every page",
    help: "AT-30. You opened each page once. Nothing looked wrong.",
  },
  {
    id: "at26_manual",
    label: "You checked the site by keyboard and screen reader",
    help: "AT-26. A person must do this check. Tests can not.",
  },
  {
    id: "money_constants",
    label: "The cost, tick, slippage and parcel figures are approved",
    help: "V1-S2, ARN-024, ARN-031, ARN-032. Production stays out of full mode until every figure shows approved below.",
  },
  {
    id: "backup_codes",
    label: "Your Google backup codes are safe and work",
    help: "BLD-010 row 13a. Keep them offline. Test one before the bot is gone.",
  },
];

export const GO_LIVE_ITEM_IDS: readonly string[] = GO_LIVE_ITEMS.map((i) => i.id);

/** The sign-off covers this market (AU is the only market, MKT-102). */
export const GO_LIVE_MARKET = "AU";
/** The Owner must type this exact phrase to sign off. */
export const SIGNOFF_CONFIRM_PHRASE = "SIGN OFF GO-LIVE";
export const SIGNOFF_NOTE_MAX = 500; // go_live_signoff.note CHECK
/** A git commit id as the sign-off row stores it (lower-case hex, 7 to 64 characters). */
export const COMMIT_RE = /^[0-9a-f]{7,64}$/;
