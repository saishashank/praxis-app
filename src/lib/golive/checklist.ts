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
    help: "Every V2 document is on scripts/ci/repo-hygiene.allow.json. Run npm run test:hygiene.",
    after: [],
  },
  {
    id: "v2_push_ci",
    phase: "before_push",
    label: "Push build and read the remote checks",
    help: "Secret scan of history, the browser tests and the Linux jobs can differ from local.",
    after: ["v2_hygiene"],
  },
  {
    id: "v2_staging_migrations",
    phase: "staging",
    label: "Staging migrations 0015 to 0023, in order",
    help: "Check the 0020 e-mail rebuild (it copies every row) and the AT-42 recorded-day row. 0023 lets the nightly features be pruned after 400 days.",
    after: ["v2_push_ci"],
  },
  {
    id: "v2_e2e",
    phase: "staging",
    label: "Run the two browser specs that never ran",
    help: "e2e/picks-sections.spec.ts and e2e/m13l-experts.spec.ts against staging.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_blueprint",
    phase: "staging",
    label: "Open the Blueprint page and an exported .drawio",
    help: "No error 500 on /blueprint and its spec tab; compare an export in draw.io desktop (D-369).",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_cortex_import",
    phase: "staging",
    label: "Import the Cortex calibration",
    help: "After 0020: node scripts/cortex/import.mjs <artefact-folder>. Confirm families allowed 0, and that the CTX-052 warm-up ran.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_experts_review",
    phase: "staging",
    label: "Review the 23 red-flag texts and fits.json",
    help: "Private folder Requirement/v2/tools/m13/. A wrong fit is parked at run time, never screened.",
    after: [],
  },
  {
    id: "v2_experts_import",
    phase: "staging",
    label: "Import the experts: dry run first",
    help: "After 0022: node scripts/experts/import.mjs <seed> --dry-run, check 100 experts, 275 items, 60 groups, 347 claims, then run it without --dry-run.",
    after: ["v2_staging_migrations", "v2_experts_review"],
  },
  {
    id: "v2_source_hosts",
    phase: "staging",
    label: "Add the regulator and paper hosts",
    help: "For example asic.gov.au and ssrn.com in SOURCE_HOSTS, so evidence links become real links (D-631).",
    after: [],
  },
  {
    id: "v2_confirm_groups",
    phase: "staging",
    label: "Confirm expert groups and claims",
    help: "Claims queue, Groups to confirm. Until then the weekly experts stage reports nothing eligible.",
    after: ["v2_experts_import"],
  },
  {
    id: "v2_r6_model",
    phase: "staging",
    label: "Wire the R6 model and review the daily total",
    help: "Run llm-bake-off.yml, assign the model in the roster, enable it. 240,000 a day needs two or more models (D-481).",
    after: [],
  },
  {
    id: "v2_quote_slots",
    phase: "staging",
    label: "Accept the delayed quote source and list the two slots",
    help: "Settings > Data sources: accept yahoo_delayed (D-398), then list quote-poll and intraday-scan. Only after the machine-route fix is deployed.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_approvals",
    phase: "approvals",
    label: "Tick the warned decisions",
    help: "D-371, D-443, D-445, D-462, D-481, D-490, D-510, D-527 and D-660, in the pull request description.",
    after: [],
  },
  {
    id: "v2_unmeasured",
    phase: "approvals",
    label: "Measure the split-day frequency and read the universe note",
    help: "node scripts/data/split-frequency.mjs --db ... against staging (DAT-232), and the two free universe sources in the licence register (O-53).",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_rollback",
    phase: "production",
    label: "Try the rollback once on staging",
    help: "docs/runbooks/rollback-v2.md: instant rollback first; the schema stays; what a V1 rebuild needs.",
    after: ["v2_staging_migrations"],
  },
  {
    id: "v2_production",
    phase: "production",
    label: "Green checks on the final commit, then approve production",
    help: "Merge only when the remote checks are green. The Cortex stays in shadow and the steelman stays off in production until the Cortex import and the R6 model are done.",
    after: ["v2_push_ci", "v2_cortex_import", "v2_rollback"],
  },
];

export const V2_GO_LIVE_STEP_IDS: readonly string[] = V2_GO_LIVE_STEPS.map((s) => s.id);
/** The in-repo guide that carries the same ids with the full text. */
export const V2_GUIDE_PATH = "docs/owner-guide/V2_go_live.md";
