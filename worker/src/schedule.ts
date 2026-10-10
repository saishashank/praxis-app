// The AU slot table as data (docs/M2_design.md section 3, "AU slot schedule (PLT-073)"). Times are
// Australia/Sydney local HH:MM (the spec says Melbourne; the two share offset and DST dates, so
// one zone key serves both). The clock (clock.ts) only ever dispatches slots that are
//  (1) `enabled`, (2) `runner: "actions"` and (3) name a workflow in DISPATCHABLE_WORKFLOWS.
// Ingest slots are listed but disabled until their workflows exist (T6, T9).
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
  /** "actions" = dispatched as a GitHub workflow; "worker" = run inside the Worker (T4/T10). */
  runner: "actions" | "worker";
  /** Workflow file under .github/workflows for runner "actions", else null. */
  workflow: string | null;
  tradingDaysOnly: boolean;
  /** Needs the market mode (market_mode for AU must not be "off"); nightly ops slots do not. */
  marketBound: boolean;
  /** Dispatch order when several are due in the same minute: lower first. */
  priority: number;
  /** A missed slot may still be dispatched this many minutes after its time (catch-up). */
  catchUpMin: number;
  enabled: boolean;
  note: string;
};

type SlotInput = Omit<Slot, "minute">;
const slot = (s: SlotInput): Slot => ({ ...s, minute: hhmm(s.time) });

/** Workflow files the clock may dispatch. Nothing else is ever sent to GitHub. */
export const DISPATCHABLE_WORKFLOWS: readonly string[] = ["backup.yml", "maintenance.yml"];

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
  slot({
    id: "pre-open",
    time: "09:55",
    runner: "worker",
    workflow: null,
    tradingDaysOnly: true,
    marketBound: true,
    priority: 2,
    catchUpMin: 5,
    enabled: false,
    note: "Pre-open re-check, DAT-122 slot 2; stub in M2 (Arena disabled)",
  }),
  slot({
    id: "ingest-batch1",
    time: "17:30",
    runner: "actions",
    workflow: "ingest-batch1.yml",
    tradingDaysOnly: true,
    marketBound: true,
    priority: 10,
    catchUpMin: 40,
    enabled: false,
    note: "Batch 1, stages 1..9 (DAT-020); complete by 18:10 so catch-up closes at the cut-off (T6)",
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
];
