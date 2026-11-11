// The slot table as data (docs/M2_design.md section 3, "AU slot schedule (PLT-073)"), built per market
// from the `market` row (M19 C1, D-996): the market-bound slots read their local HH:MM from the row's
// `slots_json` anchors (the profile projection, src/lib/market/profileCore.mjs), the market-independent ops
// slots from OPS_SLOT_TIMES, and the home market's exchange-feed slots from FEED_SLOT_TIMES. This file holds
// no market code and no clock time. `slotsFor(row)` of the AU row reproduces the former AU table to the
// byte (worker/test/auSlots.test.ts against the step-0 snapshot). Times are local HH:MM of the market zone
// (the Owner's zone for ops slots; Sydney and Melbourne share offset and DST dates). The clock (clock.ts) only ever dispatches slots that are
//  (1) `enabled`, (2) `runner: "actions"` and (3) name a workflow in DISPATCHABLE_WORKFLOWS.
// Slots whose workflow does not exist yet stay disabled (T10); ingest-batch1 exists since T6 and
// backfill-history since T9 (its slot stays disabled until the Owner enables the backfill).
import { FEED_SLOT_TIMES } from "../../src/lib/market/clockTables.mjs";
import { HOME_MARKET, OPS_SLOT_TIMES } from "../../src/lib/market/profileCore.mjs";
import { hhmm, zoneSupported } from "./localtime";
import { anchorsOf, type MarketRow, type SlotAnchors } from "./markets";

export type Slot = {
  id: string;
  /** Local start, "HH:MM" in the zone of the slot's market (ops slots: the Owner's zone). */
  time: string;
  /** `time` in minutes since local midnight (derived, never typed by hand). */
  minute: number;
  /** Recurring slots (ASX poll): last start and spacing. Not fired by the dispatch clock. */
  until?: string;
  everyMin?: number;
  /**
   * "actions" = dispatched as a GitHub workflow; "worker" = run inside the Worker (T4/T10);
   * "route" = a signed POST to a Vercel route (decision 41, M5), never dispatched by this clock.
   */
  runner: "actions" | "worker" | "route";
  /** App path for runner "route", else absent. */
  route?: string;
  /** Runner "route": extra fields of the signed body (e.g. the pre-open attempt number). */
  extra?: Record<string, string | number>;
  /** Runner "route": only post when this worker_state condition holds (alert-flush: "alert_flush_due"). */
  needs?: "alert_flush_due";
  /** Runner "route", single-shot slots: fire only while the slot with this id is not "dispatched". */
  after?: string;
  /** Runner "route", single-shot slots: attempts per occurrence (default MAX_ROUTE_ATTEMPTS). */
  maxAttempts?: number;
  /** Runner "route": request timeout in ms (default ROUTE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Workflow file under .github/workflows for runner "actions", else null. */
  workflow: string | null;
  tradingDaysOnly: boolean;
  /** Needs the market mode (the market's mode must not be "off"); nightly ops slots do not. */
  marketBound: boolean;
  /**
   * The market this slot belongs to, set only when more than one market is enabled (D-1045); absent means the
   * table's only market. A market-bound dispatch then passes it to the workflow as the `market` input and
   * the clock reads that market's mode and calendar.
   */
  market?: string;
  /** Dispatch order when several are due in the same minute: lower first. */
  priority: number;
  /** A missed slot may still be dispatched this many minutes after its time (catch-up). */
  catchUpMin: number;
  /**
   * "Available in this build" (M8 T8, decision 32). A slot with `requiresListing` is available but
   * runs only when its id is in the runtime list `worker_state.slots_enabled`; with no list it is
   * skipped (so an absent list behaves exactly as when these slots were disabled).
   */
  enabled: boolean;
  requiresListing?: boolean;
  /** Runner "actions": run only on the first Saturday of the local month (M8 T8, decision 46). */
  monthly?: "first-saturday";
  /**
   * Runner "actions": workflow inputs come from this `worker_state` key (a JSON object of strings,
   * read in the same single read as the switches). Missing, malformed or lacking one of
   * `requiredInputs` -> the slot is skipped, never dispatched with a guess.
   */
  inputsKey?: string;
  requiredInputs?: readonly string[];
  /** Runner "actions": constant workflow inputs sent with every dispatch (watchdog `slot`). */
  fixedInputs?: Record<string, string>;
  /**
   * Runner "actions": verify the night's outcome (V1-B1, D-662). A 204 from GitHub only means the
   * workflow was accepted. From `afterMin` after the dispatch until `untilMin` after the slot time,
   * a slot whose run record `<keyPrefix><local date>` is neither closed nor running is dispatched
   * again (bounded by MAX_ATTEMPTS; the script's own success check makes a duplicate a no-op).
   */
  recheck?: {
    keyPrefix: string;
    afterMin: number;
    untilMin: number;
    /**
     * M18 (D-953): re-dispatch at most once through the recheck. A dispatch made at or after
     * `slot minute + afterMin` was itself a recheck, so it is not checked again.
     */
    once?: boolean;
    /**
     * M18 (D-953): another run-record key prefix (`<prefix><local date>`) that must have a
     * success/degraded record before the re-dispatch (2b needs a settled 2a). Unknown = no re-dispatch.
     */
    needsKeyPrefix?: string;
  };
  /** Runner "actions": run only on this local calendar day each year (M18, `calendar-draft`). */
  annual?: { month: number; day: number };
  note: string;
};

type SlotInput = Omit<Slot, "minute">;
const slot = (s: SlotInput): Slot => ({ ...s, minute: hhmm(s.time) });

/** Workflow files the clock may dispatch. Nothing else is ever sent to GitHub. */
export const DISPATCHABLE_WORKFLOWS: readonly string[] = [
  "arena-close.yml",
  "arena-signals.yml",
  "asx-fetch.yml",
  "backfill-history.yml",
  "backfill-prices.yml",
  "backup.yml",
  "calendar-draft.yml",
  "ingest-batch1.yml",
  "kb-archive.yml",
  "llm-bakeoff.yml",
  "maintenance.yml",
  "replay.yml",
  "turso-usage.yml",
  "watchdog.yml",
];

export const DEFAULT_CATCH_UP_MIN = 60;

/** Slot ids that belong to the home market's exchange feed (D-194): no other market has them yet (D-1046). */
const FEED_IDS: ReadonlySet<string> = new Set([
  "asx-poll",
  "universe",
  "asx-fetch",
  "decision-cutoff",
  "late-sweep",
  "marker-check",
]);

export type TableOptions = {
  /** Tag market-bound slots with `market` (more than one market is enabled). */
  tag?: boolean;
  /** Suffix the market-bound slot ids with `:<code>` (every market but the first when several are enabled). */
  suffix?: boolean;
  /** Include the market-independent ops slots (default true; only the first market's table carries them). */
  ops?: boolean;
};

/** What a slot table is built from: the market code, its anchors and the ops and feed time tables. */
type TableInput = {
  code: string;
  a: SlotAnchors;
  ops: Record<string, { at: string; from: string; until: string; everyMin: number }>;
  feed: typeof FEED_SLOT_TIMES;
};

/** The whole table of one market, in table order (market-bound and ops slots interleaved as designed). */
const tableOf = ({ code, a, ops, feed }: TableInput): Slot[] => [
  slot({
    id: "asx-poll",
    time: feed.poll.from,
    until: feed.poll.until,
    everyMin: feed.poll.everyMin,
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 1,
    catchUpMin: 0,
    enabled: false,
    note: "ASX announcement poll, DAT-122 slot 1 (T4)",
  }),
  // M5 T6 (D-101, design 4.1/4.3): the P0 batch flush. A `route` slot: odd minutes 07:01-20:59, one
  // read of `worker_state.alert_flush_due` and, when it has passed, a signed POST. DISABLED, and the
  // dispatch clock never fires `route` slots (worker/src/routes.ts does).
  slot({
    id: "alert-flush",
    time: ops.alert_flush.from,
    until: ops.alert_flush.until,
    everyMin: ops.alert_flush.everyMin,
    runner: "route",
    route: "/api/internal/alert-flush",
    needs: "alert_flush_due",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: false,
    priority: 4,
    catchUpMin: 0,
    enabled: true,
    requiresListing: true,
    note: "P0 batch flush and missing alerts (M5 T6, decision 40); OFF until the Owner enables alerts",
  }),
  // M5 T8 (D-103, design 4.5): the pre-open re-check is a signed POST to the app route, not an ASX
  // request, so it needs no rate token; 09:54 stays on an even minute (D-061). Attempt 2 at 09:58
  // follows an error or timeout; a second failure raises the P1. Both DISABLED; the dispatch clock
  // never fires `route` slots (worker/src/routes.ts does).
  slot({
    id: "pre-open",
    time: a.preopen_recheck[0],
    runner: "route",
    route: "/api/internal/preopen",
    extra: { attempt: 1 },
    maxAttempts: 1,
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 2,
    catchUpMin: 3,
    enabled: true,
    requiresListing: true,
    note: "Pre-open re-check attempt 1 (M5 T8, ARN-020a); OFF until the Owner enables the arena",
  }),
  slot({
    id: "pre-open-retry",
    time: a.preopen_recheck[1],
    runner: "route",
    route: "/api/internal/preopen",
    extra: { attempt: 2 },
    after: "pre-open",
    maxAttempts: 1,
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 2,
    catchUpMin: 1,
    enabled: true,
    requiresListing: true,
    note: "Pre-open re-check attempt 2, only after an error or timeout of 09:54 (M5 T8); OFF with it",
  }),
  // M5 T10 (D-107, design 4.1/4.6): the Evening Review send. A `route` slot every 5 minutes from
  // 20:00 to 20:45 and (second slot) every 15 minutes from 21:00 to 22:00 Melbourne/Sydney time,
  // market-independent and every day (the review has a non-trading form). Each tick posts the signed
  // `evening-review` route, which is idempotent per review date (waiting, partial, late, complete
  // later). Both DISABLED like every M5 slot; the dispatch clock never fires `route` slots.
  slot({
    id: "evening-review",
    time: ops.evening_review.from,
    until: ops.evening_review.until,
    everyMin: ops.evening_review.everyMin,
    runner: "route",
    route: "/api/internal/evening-review",
    timeoutMs: 58_000,
    workflow: null,
    tradingDaysOnly: false,
    marketBound: false,
    priority: 5,
    catchUpMin: 0,
    enabled: true,
    requiresListing: true,
    note: "Evening Review send 20:00-20:45 (M5 T10, EML-010/011); OFF until the Owner enables emails",
  }),
  slot({
    id: "evening-review-late",
    time: ops.evening_review_late.from,
    until: ops.evening_review_late.until,
    everyMin: ops.evening_review_late.everyMin,
    runner: "route",
    route: "/api/internal/evening-review",
    timeoutMs: 58_000,
    workflow: null,
    tradingDaysOnly: false,
    marketBound: false,
    priority: 5,
    catchUpMin: 0,
    enabled: true,
    requiresListing: true,
    note: "Evening Review retry and complete-version store 21:00-22:00 (M5 T10); OFF with the slot above",
  }),
  // M5 T13 (D-108): health snapshot, attention reminder and Morning Brief. DISABLED like every M5
  // slot. Single shot at 08:00; the route itself is idempotent per day (one snapshot, one email key).
  slot({
    id: "morning",
    time: ops.morning.at,
    runner: "route",
    route: "/api/internal/morning",
    timeoutMs: 58_000,
    workflow: null,
    tradingDaysOnly: false,
    marketBound: false,
    priority: 5,
    catchUpMin: 30,
    enabled: true,
    requiresListing: true,
    note: "Morning health snapshot, attention reminder and Morning Brief (M5 T13, PLT-061); OFF until the Owner enables emails",
  }),
  slot({
    id: "universe",
    time: feed.universe.at,
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 3,
    catchUpMin: 0,
    enabled: false,
    note:
      "ASX listed-companies file, DAT-122 priority 3 (T11, D-067): once per trading day, " +
      "even minute, never within 65 s of a poll (polls 07:28 and 07:32)",
  }),
  // D-194: asx.com.au blocks this Worker's requests (asx_block_trip, 403/challenge) but answers
  // GitHub's runners, so the announcements and the company list are fetched there. Every 30 minutes
  // on trading days, one request at a time with spacing (DAT-122); runs whenever dispatch is on.
  slot({
    id: "asx-fetch",
    time: feed.fetch.from,
    until: feed.fetch.until,
    everyMin: feed.fetch.everyMin,
    runner: "actions",
    workflow: "asx-fetch.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 9,
    catchUpMin: 25,
    enabled: true,
    note: "ASX announcements and listed companies via GitHub (D-194): the Worker is blocked by asx.com.au",
  }),
  slot({
    id: "ingest-batch1",
    time: a.b1,
    runner: "actions",
    workflow: "ingest-batch1.yml",
    // M5 T10 (D-107, decision 5): also on weekends and holidays, so the reduced pipeline writes the
    // `non-trading` marker by 19:45 (DAT-022) and the Evening Review can send its non-trading form.
    // Still inert while `dispatch_enabled` is off.
    tradingDaysOnly: false,
    marketBound: true,
    priority: 10,
    catchUpMin: 40,
    enabled: true,
    note: "Batch 1, stages 1..9 (DAT-020), every day incl. non-trading (marker by 19:45); complete by 18:10 so catch-up closes at the cut-off (T6)",
  }),
  // M3 T10 (D-077): batch 2a "close the books". The workflow exists and is allow-listed, but the
  // slot stays OFF until the Owner approves the [VERIFY] items and enables the arena (D-066: the
  // script itself also refuses to write while market.mode is not `full`). It starts after
  // Batch 1's catch-up window and waits for the completion marker; 2b (18:10) needs its result.
  slot({
    id: "arena-close",
    time: a.b2a,
    runner: "actions",
    workflow: "arena-close.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 15,
    catchUpMin: 20,
    recheck: { keyPrefix: `arena-2a:${code}:`, afterMin: 30, untilMin: 150 },
    enabled: true,
    requiresListing: true,
    note: "Batch 2a close the books (T10, ARN-060): fills, stops, settlement, NAV, invariants; OFF until the Owner enables the arena",
  }),
  // M4 T8 (D-087): batch 2b "signals and orders". Allow-listed, slot OFF like arena-close: the
  // script waits for batch 2a of the same session and, with market.mode other than `full`, writes
  // only a skipped run record (D-066). It decides one session; there is no catch-up.
  // M18 OPS-106 (D-666, D-953): 2b waits 20 minutes for 2a and then records `skipped (no_2a_success)`.
  // From 18:25 to 18:40 a 2b that has not closed its night is dispatched again ONCE, and only when 2a has
  // a success/degraded record by then (`needsKeyPrefix`); after 18:40 the script itself records the night
  // as degraded `late_2a`. Scheduling only: the inputs and outputs of 2b are unchanged.
  slot({
    id: "arena-signals",
    time: a.b2b,
    runner: "actions",
    workflow: "arena-signals.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 16,
    catchUpMin: 30,
    // M18 OPS-106 (D-666, D-953): recheck from 18:25 to 18:40, once, needs a settled 2a (see above the slot).
    recheck: {
      keyPrefix: `arena-2b:${code}:`,
      afterMin: 15,
      untilMin: 30,
      once: true,
      needsKeyPrefix: `arena-2a:${code}:`,
    },
    enabled: true,
    requiresListing: true,
    note: "Batch 2b signals and orders (M4 T8, ARN-060/020): A4/A3/A2, family rules, exits, FAM-001 entries, C2/C3 controls; OFF until the Owner enables the arena",
  }),
  // GL-05 (D-207 item 5): the decision cut-off poll. A trading-day announcement fetch starts at 18:10
  // (the 30-minute `asx-fetch` cadence has no run between 18:00 and 18:30). The first poll that
  // started at or after 18:10 and stored its items writes the insert-once marker `cutoff_poll:AU:<d>`
  // (src/lib/data/asxIngest.ts, and the Worker's own poll in worker/src/asx/slots.ts, which keys on
  // this slot being enabled). Batch 2b waits for the marker for at most 4 minutes and then goes on,
  // recording `cutoff_poll_missing`. A single try (no catch-up): a poll later than 18:14 is too late.
  slot({
    id: "decision-cutoff",
    time: a.cutoff_poll,
    runner: "actions",
    workflow: "asx-fetch.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 11,
    catchUpMin: 2,
    enabled: true,
    note: "Decision cut-off poll (GL-05): the first completed announcement poll after 18:10 is the marker batch 2b waits for (4 min)",
  }),
  slot({
    id: "late-sweep",
    time: feed.late_sweep.at,
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 12,
    catchUpMin: 10,
    enabled: false,
    note: "Late sweep (D+1 inputs); must finish before 19:45 (T6)",
  }),
  slot({
    id: "marker-check",
    time: feed.marker_check.at,
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 13,
    catchUpMin: 10,
    enabled: false,
    note: "Completion-marker check; in-app incident if missing (T10)",
  }),
  // Not in the design table: the spec fixes no local time for the nightly jobs (PLT-022 says
  // "nightly"). Chosen after the evening email window (20:00..20:45) and the last YAML watchdog
  // (21:50); recorded as a decision in the T3 report.
  slot({
    id: "maintenance",
    time: ops.maintenance.at,
    runner: "actions",
    workflow: "maintenance.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 20,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    note: "Nightly maintenance (retention, personal-data hashing)",
  }),
  slot({
    id: "backup",
    time: ops.backup.at,
    runner: "actions",
    workflow: "backup.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 21,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    note: "Nightly encrypted backup and restore drill",
  }),
  slot({
    id: "backfill-history",
    time: ops.backfill_history.at,
    runner: "actions",
    workflow: "backfill-history.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 22,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    requiresListing: true,
    note: "History backfill (T9, DAT-125/125a): ASIC files and announcement exports; OFF until the Owner enables it",
  }),
  slot({
    id: "backfill-prices",
    time: ops.backfill_prices.at,
    runner: "actions",
    workflow: "backfill-prices.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 23,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    requiresListing: true,
    note: "Yahoo price-history backfill (T16a, D-086/D-092): one month per run; OFF until the Owner accepts the source (O-26) and enables it",
  }),
  // M4 T16 (D-095): the replay workflow (default mode light). Allow-listed, slot OFF until the Owner
  // enables the replay (weekly light, monthly full; the Owner dispatches the other modes by hand).
  slot({
    id: "replay",
    time: ops.replay.at,
    runner: "actions",
    workflow: "replay.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 24,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    requiresListing: true,
    note: "Replay light/full/evidence/null/injected (T16, ARN-080/100, AT-17); OFF until the Owner enables it",
  }),
  // M6 T13 (D-116 draft): the knowledge-base archive to the private data repo (KB-001, PLT-022a).
  // Allow-listed, slot OFF until the Owner enables it (design 4.8).
  slot({
    id: "kb-archive",
    time: ops.kb_archive.at,
    runner: "actions",
    workflow: "kb-archive.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 25,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    requiresListing: true,
    note: "KB document archive to the data repo (M6 T13, KB-001); OFF until the Owner enables it",
  }),
  // M8 T8 (decision 46, LLM-040): the monthly LLM bake-off, first Saturday of the Sydney month, 10:00
  // (the run takes up to two hours; a Saturday keeps it clear of every weekday pipeline). Available but
  // listed-only like every go-live slot. The candidates are the Owner's choice, so the inputs are read
  // from `worker_state.bakeoff_inputs` ({"candidates": "KIND:MODEL ...", optional trains/checked/store}).
  slot({
    id: "llm-bakeoff",
    time: ops.llm_bakeoff.at,
    runner: "actions",
    workflow: "llm-bakeoff.yml",
    monthly: "first-saturday",
    inputsKey: "bakeoff_inputs",
    requiredInputs: ["candidates"],
    tradingDaysOnly: false,
    marketBound: false,
    priority: 26,
    catchUpMin: DEFAULT_CATCH_UP_MIN,
    enabled: true,
    requiresListing: true,
    note: "Monthly LLM bake-off (M8 T8, decision 46): first Saturday 10:00; OFF until the Owner lists it and sets the candidates",
  }),
  // M8 T13 (PLT-071, NFR-006, D-106, D-155): the YAML watchdog runs at 20:40 and 21:50 Melbourne,
  // every day (it checks the Evening Review, which also has a non-trading form). watchdog.yml is
  // dispatch-only (no `schedule:`), so these Worker slots are its only trigger; the `slot` input
  // stands for the time. Listed-only like every go-live slot. Catch-up 30 min for 20:40 (a late run still
  // closes before the 21:00 review retry) and 20 min for 21:50 (ends before the 22:15 archive tick).
  slot({
    id: "watchdog-2040",
    time: ops.watchdog_2040.at,
    runner: "actions",
    workflow: "watchdog.yml",
    fixedInputs: { slot: "2040" },
    tradingDaysOnly: false,
    marketBound: false,
    priority: 27,
    catchUpMin: 30,
    enabled: true,
    requiresListing: true,
    note: "YAML watchdog 20:40 (M8 T13, PLT-071, NFR-006): sends the review if none went out; OFF until the Owner lists it",
  }),
  slot({
    id: "watchdog-2150",
    time: ops.watchdog_2150.at,
    runner: "actions",
    workflow: "watchdog.yml",
    fixedInputs: { slot: "2150" },
    tradingDaysOnly: false,
    marketBound: false,
    priority: 28,
    catchUpMin: 20,
    enabled: true,
    requiresListing: true,
    note: "YAML watchdog 21:50 (M8 T13, PLT-071, NFR-006): last check of the worker poll and the review; OFF until the Owner lists it",
  }),
  // M17 WP5 (D-387, D-397, PLT-077): delayed-quote slots. Recurring route slots: one signed POST per
  // matching minute, no slot state; the routes are idempotent per (market, session, slot minute, purpose)
  // through quote_run and enforce the early close from the calendar. Available but listed-only (an absent
  // list skips them) and the routes themselves refuse until the Owner accepts the yahoo_delayed source.
  slot({
    id: "quote-poll",
    time: a.quote_from,
    until: a.quote_until,
    everyMin: 5,
    runner: "route",
    route: "/api/internal/pick-alerts",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 5,
    catchUpMin: 0,
    enabled: true,
    requiresListing: true,
    note: "Pick-alert quote poll 10:00-16:00 every 5 min (M17, PLT-077); OFF until the Owner lists it and accepts the quote source",
  }),
  slot({
    id: "intraday-scan",
    // V2-I1 (D-770): offset 2 minutes so the scan never shares a tick with quote-poll (multiples of 5).
    time: a.intraday_scan_from,
    until: a.intraday_scan_until,
    everyMin: 30,
    runner: "route",
    route: "/api/internal/intraday-scan",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 6,
    catchUpMin: 0,
    enabled: true,
    requiresListing: true,
    note: "Intraday scan 10:32-15:32 every 30 min (M17, AGT-140); OFF until the Owner lists it and accepts the quote source",
  }),
  // M18 OPS-103 (D-961): the yearly trading-calendar draft, 1 November 09:00 Melbourne (Sydney time is
  // the same clock). calendar-draft.yml is dispatch-only; with no `market` and no `year` input it drafts
  // next year for every market that has calendar rules (the market set lives in the script, so no market
  // literal is added here). The draft is idempotent (it only inserts into a year with no rows), so a long
  // catch-up is safe. Listed-only like every go-live slot.
  slot({
    id: "calendar-draft",
    time: ops.calendar_draft.at,
    runner: "actions",
    workflow: "calendar-draft.yml",
    annual: { month: 11, day: 1 },
    tradingDaysOnly: false,
    marketBound: false,
    priority: 29,
    catchUpMin: 180,
    enabled: true,
    requiresListing: true,
    note: "Yearly trading-calendar draft (M18 OPS-103, D-961): 1 November 09:00; OFF until the Owner lists it",
  }),
  // M18 OPS-104 (D-958): the daily Turso usage sample, 06:40 Melbourne, before the market day. The
  // workflow holds the platform token (a GitHub environment secret, never on Vercel or here) and skips
  // with source `unavailable` while it is absent. Idempotent per day (one sample row per run).
  slot({
    id: "turso-usage",
    time: ops.turso_usage.at,
    runner: "actions",
    workflow: "turso-usage.yml",
    tradingDaysOnly: false,
    marketBound: false,
    priority: 30,
    catchUpMin: 120,
    enabled: true,
    requiresListing: true,
    note: "Daily Turso usage sample (M18 OPS-104, D-958): 06:40; OFF until the Owner lists it",
  }),
];

/**
 * The slot table of one enabled market row, in table order (market-bound and ops slots interleaved as
 * designed). Throws `unsupported zone` for a market whose zone the Worker cannot compute (D-1004) and
 * RangeError for an unusable `slots_json`; the clock catches both per market and skips that market.
 */
export function slotsFor(row: MarketRow, opts: TableOptions = {}): readonly Slot[] {
  if (!zoneSupported(row.tz)) throw new RangeError("unsupported zone");
  const a = anchorsOf(row);
  const code = row.code;
  // the ops table as the one shape its entries share (a point has `at`, a window has from/until/everyMin)
  const ops = OPS_SLOT_TIMES as unknown as Record<
    string,
    { at: string; from: string; until: string; everyMin: number }
  >;
  const feed = FEED_SLOT_TIMES;
  const table = tableOf({ code, a, ops, feed });
  return table
    .filter(
      (x) => (code === HOME_MARKET || !FEED_IDS.has(x.id)) && (opts.ops !== false || x.marketBound),
    )
    .map((x) => {
      if (!x.marketBound) return x;
      const out: Slot = { ...x };
      if (opts.suffix === true) {
        out.id = `${x.id}:${code}`;
        if (x.after !== undefined) out.after = `${x.after}:${code}`;
      }
      if (opts.tag === true) {
        out.market = code;
        // the market reaches the job: the `market` input of a workflow, the `market` field of a signed post
        // (the feed workflow has no such input and only the home market has it)
        if (out.runner === "actions" && !FEED_IDS.has(x.id)) {
          out.fixedInputs = { ...(x.fixedInputs ?? {}), market: code };
        }
        if (out.runner === "route") out.extra = { ...(x.extra ?? {}), market: code };
      }
      return out;
    });
}

/**
 * The slot table of every enabled market, in code order (D-996). One market: `slotsFor(row)` untagged (the
 * AU table of the snapshot). Several: the first market's full table, tagged, plus each later market's
 * market-bound slots with `:<code>` ids and tags; the ops slots appear once. A market whose zone or anchors
 * are unusable is left out and named in `skipped` (never thrown: one broken row must not stop the others).
 */
let tableOverride: readonly Slot[] | null = null;
/** Test hook: the whole-Worker budget tests run a table they modified (every slot on, piled up). Never used in production. */
export function overrideSlotTableForTests(table: readonly Slot[] | null): void {
  tableOverride = table;
}

export function slotTable(rows: readonly MarketRow[]): { slots: Slot[]; skipped: string[] } {
  if (tableOverride !== null) return { slots: [...tableOverride], skipped: [] };
  const ok: { row: MarketRow; usable: boolean }[] = rows.map((row) => {
    try {
      slotsFor(row);
      return { row, usable: true };
    } catch {
      return { row, usable: false };
    }
  });
  const usable = ok.filter((x) => x.usable).map((x) => x.row);
  const skipped = ok.filter((x) => !x.usable).map((x) => x.row.code);
  const slots: Slot[] = [];
  const multi = usable.length > 1;
  usable.forEach((row, i) => {
    slots.push(...slotsFor(row, { tag: multi, suffix: multi && i > 0, ops: i === 0 }));
  });
  return { slots, skipped };
}
