// The go-live checklist and the typed confirmation (M8 T11; docs/M8_design.md section 7 phase P6,
// decisions 24 and 33). Pure data, no server imports: the page, the action and the tests share it.
// Every item must be ticked before a sign-off row can be written (the server checks the full set;
// the page only mirrors it). Wording is plain English and names no secret value.

export type GoLiveItem = { readonly id: string; readonly label: string; readonly help: string };

export const GO_LIVE_ITEMS: readonly GoLiveItem[] = [
  {
    id: "pat_revoked",
    label: "The build access token is revoked and the build bot is removed",
    help: "AT-30, SEC-108 e: after this no code change is possible until a new short-lived token is issued.",
  },
  {
    id: "tokens_rotated",
    label: "Every production secret is rotated and its smoke test passed",
    help: "AT-30, SEC-021: the rotation order and the smoke runs are in the go-live Owner guide.",
  },
  {
    id: "restore_drill",
    label: "The real-key restore drill is green and both of its secrets are deleted",
    help: "AT-30, TST-108: run the restore drill with the real key; the last step is green only after the secrets are removed.",
  },
  {
    id: "zero_cost",
    label: "The $0 check is done on every provider",
    help: "AT-30: each provider shows no charge and no card on a paid plan.",
  },
  {
    id: "walkthrough",
    label: "The walkthrough of the six tabs and every gear-menu page is done",
    help: "AT-30: you opened each page once as the Owner and nothing looked wrong.",
  },
  {
    id: "at26_manual",
    label: "The AT-26 manual keyboard and screen-reader check is done",
    help: "AT-26: the manual accessibility check that no automated test can replace.",
  },
  {
    id: "backup_codes",
    label: "The Google backup codes are stored offline and were tested once",
    help: "BLD-010 row 13a: the recovery path must work before the bot and the token are gone.",
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
