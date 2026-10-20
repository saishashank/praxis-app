// The AU slot table as data (docs/M2_design.md section 3, "AU slot schedule (PLT-073)"). Times are
// Australia/Sydney local HH:MM (the spec says Melbourne; the two share offset and DST dates, so
// one zone key serves both). The clock (clock.ts) only ever dispatches slots that are
//  (1) `enabled`, (2) `runner: "actions"` and (3) name a workflow in DISPATCHABLE_WORKFLOWS.
// Slots whose workflow does not exist yet stay disabled (T10); ingest-batch1 exists since T6 and
// backfill-history since T9 (its slot stays disabled until the Owner enables the backfill).
import { hhmm } from "./localtime";

export type Slot = {
  id: string;
  /** Local start, "HH:MM" Australia/Sydney. */
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
  /** Needs the market mode (market_mode for AU must not be "off"); nightly ops slots do not. */
  marketBound: boolean;
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
  note: string;
};

type SlotInput = Omit<Slot, "minute">;
const slot = (s: SlotInput): Slot => ({ ...s, minute: hhmm(s.time) });

/** Workflow files the clock may dispatch. Nothing else is ever sent to GitHub. */
export const DISPATCHABLE_WORKFLOWS: readonly string[] = [
  "arena-close.yml",
  "arena-signals.yml",
  "backfill-history.yml",
  "backfill-prices.yml",
  "backup.yml",
  "ingest-batch1.yml",
  "kb-archive.yml",
  "llm-bakeoff.yml",
  "maintenance.yml",
  "replay.yml",
];

export const DEFAULT_CATCH_UP_MIN = 60;

export const AU_SLOTS: readonly Slot[] = [
  slot({
    id: "asx-poll",
    time: "07:00",
    until: "19:30",
    everyMin: 4,
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
    time: "07:01",
    until: "20:59",
    everyMin: 2,
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
    time: "09:54",
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
    time: "09:58",
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
    time: "20:00",
    until: "20:45",
    everyMin: 5,
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
    time: "21:00",
    until: "22:00",
    everyMin: 15,
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
    time: "08:00",
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
    time: "07:30",
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
  slot({
    id: "ingest-batch1",
    time: "17:30",
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
    time: "17:50",
    runner: "actions",
    workflow: "arena-close.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 15,
    catchUpMin: 20,
    enabled: true,
    requiresListing: true,
    note: "Batch 2a close the books (T10, ARN-060): fills, stops, settlement, NAV, invariants; OFF until the Owner enables the arena",
  }),
  // M4 T8 (D-087): batch 2b "signals and orders". Allow-listed, slot OFF like arena-close: the
  // script waits for batch 2a of the same session and, with market.mode other than `full`, writes
  // only a skipped run record (D-066). It decides one session; there is no catch-up.
  slot({
    id: "arena-signals",
    time: "18:10",
    runner: "actions",
    workflow: "arena-signals.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 16,
    catchUpMin: 30,
    enabled: true,
    requiresListing: true,
    note: "Batch 2b signals and orders (M4 T8, ARN-060/020): A4/A3/A2, family rules, exits, FAM-001 entries, C2/C3 controls; OFF until the Owner enables the arena",
  }),
  slot({
    id: "decision-cutoff",
    time: "18:10",
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 11,
    catchUpMin: 0,
    enabled: false,
    note: "Decision cut-off: M2 records only the first completed poll after 18:10 (T4)",
  }),
  slot({
    id: "late-sweep",
    time: "19:35",
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
    time: "19:50",
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
    time: "22:30",
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
    time: "23:00",
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
    time: "23:30",
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
    time: "23:45",
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
    time: "00:15",
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
    time: "22:15",
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
    time: "10:00",
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
];
