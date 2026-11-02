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

// ---- V2 steps (V2-S9, D-706) ----------------------------------------------------------------------------------------
// The Owner's V2 go-live steps, in execution order, consolidated from the exit documents of M8.1, M14, M15, M16,
// M17, M11L and M13L and the V2 pull request. They are NOT part of the V1 sign-off above (production was signed
// off before V2 existed and `go_live_signoff` is append-only): they are a read-only guide the page shows to the
// Owner at all times, with tick marks the Owner keeps on their own device. The full text is
// docs/owner-guide/V2_go_live.md, which carries the same ids; a test keeps the two in step.

export type V2Phase = "before_push" | "staging" | "approvals" | "production";

export type V2GoLiveStep = {
  readonly id: string;
  readonly phase: V2Phase;
  readonly label: string;
  readonly help: string;
  /** Ids of steps that must be done first (the order matters: 0022 before the experts import, ...). */
  readonly after: readonly string[];
};

export const V2_PHASE_LABELS: Readonly<Record<V2Phase, string>> = {
  before_push: "Before the first push",
  staging: "On staging",
  approvals: "Your approvals",
  production: "Before production",
};

export const V2_GO_LIVE_STEPS: readonly V2GoLiveStep[] = [
  {
    id: "v2_hygiene",
    phase: "before_push",
    label: "Check the repo hygiene list",
    help: "Run the hygiene test. The owner guide has the command.",
    after: [],
  },
  {
    id: "v2_zap_pin",
    phase: "before_push",
    label: "Turn on the ZAP pin",
    help: "Set ZAP_IMAGE_PINNED to true in GitHub. Do this before the push. The guide shows where.",
    after: ["v2_hygiene"],
  },
  {
    id: "v2_push_ci",
    phase: "before_push",
    label: "Push build and read the remote checks",
    help: "Remote checks can fail when local ones pass. Wait for green.",
    after: ["v2_hygiene", "v2_zap_pin"],
  },
  {
    id: "v2_staging_migrations",
    phase: "staging",
    label: "Run the staging migrations, in order",
    help: "Run them one by one. Watch the e-mail table rebuild. The guide lists the rest.",
    after: ["v2_push_ci"],
  },
  {
    id: "v2_cron_accepted",
    phase: "staging",
    label: "Check that Vercel took the cron jobs",
    help: "After the first staging deploy, look at the Cron Jobs list. It should show all eight jobs. If one is missing, tell the build.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_e2e",
    phase: "staging",
    label: "Run the two browser tests that never ran",
    help: "Run them on staging. The guide names both files.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_architecture_page",
    phase: "staging",
    label: "Open the hidden page and an exported drawing",
    help: "The guide gives the address. The app never links to it. Check that it opens without errors.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_cortex_import",
    phase: "staging",
    label: "Load the Cortex calibration",
    help: "Run the import after the e-mail rebuild. Then check the warm-up ran. The guide has the steps.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_experts_review",
    phase: "staging",
    label: "Review the red flag texts and the fit file",
    help: "They are in the private folder. A bad fit is parked, never used.",
    after: [],
  },
  {
    id: "v2_experts_import",
    phase: "staging",
    label: "Load the experts, dry run first",
    help: "Check the counts in the dry run. Then run it for real. The guide has the counts.",
    after: ["v2_staging_migrations", "v2_experts_review"],
  },
  {
    id: "v2_source_hosts",
    phase: "staging",
    label: "Add the regulator and paper hosts",
    help: "Add them to the list of source hosts. Then evidence links become real links.",
    after: [],
  },
  {
    id: "v2_confirm_groups",
    phase: "staging",
    label: "Confirm expert groups and claims",
    help: "Use the claims queue. Until then the weekly stage finds nothing to do.",
    after: ["v2_experts_import"],
  },
  {
    id: "v2_r6_model",
    phase: "staging",
    label: "Wire the R6 model and check the daily total",
    help: "Run the bake-off, pick a model and turn it on. The daily total needs two or more models.",
    after: [],
  },
  {
    id: "v2_quote_slots",
    phase: "staging",
    label: "Accept the delayed quotes and list the two slots",
    help: "Do this in Settings, then Data sources. Only list the slots after the route fix is live.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_approvals",
    phase: "approvals",
    label: "Tick the warned decisions",
    help: "Tick each one in the pull request text. The guide lists them all.",
    after: [],
  },
  {
    id: "v2_unmeasured",
    phase: "approvals",
    label: "Measure how often shares split",
    help: "Run the script against staging. Also read the note on free share lists.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_money_constants",
    phase: "approvals",
    label: "Approve the cost, tick, slippage and parcel figures",
    help: "Check them, then press Approve on the go-live page. Until you do, production stays out of full mode.",
    after: [],
  },
  {
    id: "v2_restore_size",
    phase: "production",
    label: "Time a full-size restore",
    help: "Run it once on fake rows. Write down the date, the result and the time.",
    after: [],
  },
  {
    id: "v2_rollback",
    phase: "production",
    label: "Try the rollback once on staging",
    help: "Follow the rollback runbook. Roll back first, and keep the schema.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_merge_main",
    phase: "production",
    label: "Merge build into main when checks are green",
    help: "This is the one V2 pull request. Merge it only on green. It deploys staging only.",
    after: ["v2_push_ci", "v2_cortex_import", "v2_restore_size", "v2_rollback"],
  },
  {
    id: "v2_release_evidence",
    phase: "production",
    label: "Collect the release evidence on main",
    help: "Run Staging E2E day, ZAP baseline, Nightly and a restore drill. The guide says how.",
    after: ["v2_merge_main"],
  },
  {
    id: "v2_production",
    phase: "production",
    label: "Release to production",
    help: "The agent opens the release pull request. You merge it and approve the deploy. The release branch is rc/<sha>. The Cortex stays in shadow until its import and the R6 model are done.",
    after: ["v2_merge_main", "v2_release_evidence", "v2_cortex_import", "v2_r6_model"],
  },
];

export const V2_GO_LIVE_STEP_IDS: readonly string[] = V2_GO_LIVE_STEPS.map((s) => s.id);
/** The in-repo guide that carries the same ids with the full text. */
export const V2_GUIDE_PATH = "docs/owner-guide/V2_go_live.md";
