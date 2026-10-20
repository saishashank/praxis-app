// Deadline checker for one Melbourne trading date (M8 T12; docs/M8_design.md 2.2, decision 45;
// TST-106, AT-28, PLT-073, PLT-071). It READS what every job already wrote (`run_record`,
// `completion_marker`, `email_message`, `preopen_run`) and reports, per step, whether it finished
// on time, late, never, or is not due yet. Nothing is written; no log is parsed.
//
// Deadlines. PLT-073 (spec/13 l.60): "each step's deadline is the next step's start". The step
// start times below are that table; the ones that are also configuration keys are read from the
// configuration (decision_cutoff, evening_review_time, send_by), and the pre-open deadline is the
// market's open time from the `market` row. tests/runs/deadlines.test.ts compares this table with
// the spec text and with the Worker's slot table, so the three cannot drift apart.
//   - Early-close days keep the same fixed evening times (PLT-073 s13), so the table never changes
//     with the calendar; only "is it a trading day" matters (a holiday or weekend skips the
//     trading-only steps).
//   - Times are Australia/Melbourne wall-clock times turned into instants with the calendar's
//     `localToUtc` (D-059): a time inside the spring-forward gap moves forward, a time in the
//     fall-back overlap takes the first occurrence. Stored timestamps are UTC ISO strings, so a
//     comparison is always between two instants and DST cannot shift a result.
// Output carries step names and HH:MM times only (SEC-110): no data value, no URL.
import type { Client } from "@libsql/client";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { isTradingDay, localToUtc, type CalendarKind, type CalendarRow } from "@/lib/data/calendar";

export const DEADLINE_TZ = "Australia/Melbourne";
export const DEADLINE_MARKET = "AU";

export type DeadlineStatus = "on_time" | "late" | "missing" | "not_due";

export type StepSource =
  | { kind: "run"; job: string }
  | { kind: "marker"; kinds: readonly string[] }
  | { kind: "email" }
  | { kind: "preopen" };

export type StepDef = {
  id: string;
  label: string;
  source: StepSource;
  /** Local start "HH:MM" (PLT-073). */
  start: string;
  /** Config key that overrides `start` when the key is a time of day. */
  startKey?: ConfigKey;
  /** Local deadline "HH:MM", or null = the market open time. */
  deadline: string | null;
  deadlineKey?: ConfigKey;
  /** Skipped (not due) on a weekend or holiday. */
  tradingOnly: boolean;
};

// PLT-073, spec/13 l.60. Deadline = next step's start; exceptions are noted on the row.
export const STEPS: readonly StepDef[] = [
  {
    id: "preopen",
    label: "Pre-open re-check",
    source: { kind: "preopen" },
    start: "09:54", // ARN-020a; the deadline is the market open
    deadline: null,
    tradingOnly: true,
  },
  {
    id: "batch1",
    label: "Batch 1 (prices, actions, universe)",
    source: { kind: "run", job: "ingest-batch1" },
    start: "17:30",
    deadline: "18:10",
    deadlineKey: "decision_cutoff",
    tradingOnly: false, // runs every day; a non-trading day ends with a `non-trading` marker
  },
  {
    id: "batch2",
    label: "Batch 2 (signals and orders)",
    source: { kind: "run", job: "arena-signals" },
    start: "18:10",
    startKey: "decision_cutoff",
    deadline: "18:40",
    tradingOnly: true,
  },
  {
    id: "batch3",
    label: "Batch 3 (close the books, review numbers)",
    source: { kind: "run", job: "arena-review" },
    start: "18:40",
    deadline: "19:10",
    tradingOnly: true,
  },
  {
    id: "narrative",
    label: "Narrative and critic",
    source: { kind: "run", job: "arena-words" },
    start: "19:10",
    deadline: "19:35",
    tradingOnly: true,
  },
  {
    id: "late_sweep",
    label: "Late-announcement sweep",
    source: { kind: "marker", kinds: ["late_sweep"] },
    start: "19:35",
    deadline: "19:45", // PLT-073 s13: it MUST finish before the completion marker
    tradingOnly: true,
  },
  {
    id: "marker",
    label: "Completion marker",
    source: { kind: "marker", kinds: ["data", "non-trading"] },
    start: "19:45",
    deadline: "19:50", // PLT-071: the watchdog alerts when the marker is missing at 19:50
    tradingOnly: false,
  },
  {
    id: "email",
    label: "Evening Review email",
    source: { kind: "email" },
    start: "20:00",
    startKey: "evening_review_time",
    deadline: "20:45",
    deadlineKey: "send_by",
    tradingOnly: false,
  },
];

/** What a job left behind for the date. Times are UTC ISO strings. */
export type Observation = {
  startedAt: string | null;
  /** When the step finished (ended or sent). Null while still running. */
  finishedAt: string | null;
  /** False when the run failed. */
  ok: boolean;
};

export type Observations = Partial<Record<string, Observation | null>>;

export type StepRow = {
  id: string;
  label: string;
  start: string;
  deadline: string;
  /** "HH:MM" Melbourne of the observed start and finish, null when unknown. */
  startedAt: string | null;
  finishedAt: string | null;
  status: DeadlineStatus;
  reason: string;
};

export type DayInput = {
  /** Melbourne date YYYY-MM-DD (the trading date). */
  date: string;
  calendar: readonly CalendarRow[];
  observations: Observations;
  now: Date;
  /** Market open "HH:MM" local; the pre-open deadline. */
  openTime: string;
  /** Resolved config values by key (only time-of-day strings are used). */
  config?: Partial<Record<ConfigKey, unknown>>;
  tz?: string;
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeOf(v: unknown, fallback: string): string {
  return typeof v === "string" && HHMM.test(v) ? v : fallback;
}

/** "HH:MM" Melbourne wall clock of an instant. */
export function hhmmLocal(utc: Date, tz: string = DEADLINE_TZ): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

function iso(v: string | null): Date | null {
  if (v === null) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The step times of a day after the configuration overrides (exposed for tests and the CLI). */
export function resolveTimes(
  step: StepDef,
  config: Partial<Record<ConfigKey, unknown>>,
  openTime: string,
): { start: string; deadline: string } {
  const start = step.startKey ? timeOf(config[step.startKey], step.start) : step.start;
  const deadline =
    step.deadline === null
      ? openTime
      : step.deadlineKey
        ? timeOf(config[step.deadlineKey], step.deadline)
        : step.deadline;
  return { start, deadline };
}

/** Pure: one row per step for the date. */
export function evaluateDay(input: DayInput): StepRow[] {
  const tz = input.tz ?? DEADLINE_TZ;
  const trading = isTradingDay(input.date, input.calendar);
  const config = input.config ?? {};
  return STEPS.map((step): StepRow => {
    const { start, deadline } = resolveTimes(step, config, input.openTime);
    const base = { id: step.id, label: step.label, start, deadline };
    const dueAt = localToUtc(input.date, deadline, tz);
    const obs = input.observations[step.id] ?? null;
    const startedAt = obs?.startedAt ? hhmmLocal(iso(obs.startedAt) ?? dueAt, tz) : null;
    const fin = obs ? iso(obs.finishedAt) : null;
    const finishedAt = fin ? hhmmLocal(fin, tz) : null;
    const row = (status: DeadlineStatus, reason: string): StepRow => ({
      ...base,
      startedAt,
      finishedAt,
      status,
      reason,
    });

    if (step.tradingOnly && !trading) return row("not_due", "not a trading day");
    if (obs === null) {
      return input.now.getTime() < dueAt.getTime()
        ? row("not_due", `not due before ${deadline}`)
        : row("missing", `no record by ${deadline}`);
    }
    if (!obs.ok) return row("missing", "the run failed");
    if (fin === null) {
      return input.now.getTime() < dueAt.getTime()
        ? row("not_due", "still running")
        : row("missing", `not finished by ${deadline}`);
    }
    return fin.getTime() <= dueAt.getTime()
      ? row("on_time", `finished ${finishedAt}`)
      : row("late", `finished ${finishedAt}, deadline ${deadline}`);
  });
}

/** True when no row is late or missing (not-due rows do not count against the day). */
export function dayPasses(rows: readonly StepRow[]): boolean {
  return rows.every((r) => r.status === "on_time" || r.status === "not_due");
}

// ---- reading the records ------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Earliest finished ok run, else the latest failed one, else a running one. */
function pickRun(rows: readonly Raw[]): Observation | null {
  const mapped = rows.map((r) => ({
    startedAt: str(r.started_at),
    finishedAt: str(r.ended_at),
    status: String(r.status),
  }));
  const done = mapped
    .filter((r) => r.finishedAt !== null && r.status !== "failed" && r.status !== "running")
    .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
  if (done.length)
    return { startedAt: done[0].startedAt, finishedAt: done[0].finishedAt, ok: true };
  const running = mapped.filter((r) => r.status === "running");
  if (running.length) return { startedAt: running[0].startedAt, finishedAt: null, ok: true };
  const failed = mapped.filter((r) => r.status === "failed");
  if (failed.length) {
    const f = failed[failed.length - 1];
    return { startedAt: f.startedAt, finishedAt: f.finishedAt, ok: false };
  }
  return null;
}

/** Reads the four record tables for one date (read-only). `env` is the email_message env. */
export async function readObservations(
  db: Client,
  date: string,
  env: string,
  market: string = DEADLINE_MARKET,
): Promise<Observations> {
  const out: Record<string, Observation | null> = {};
  for (const step of STEPS) {
    const s = step.source;
    if (s.kind === "run") {
      const rs = await db.execute({
        sql: `SELECT started_at, ended_at, status FROM run_record
              WHERE job = ? AND scheduled_for = ? ORDER BY started_at, id`,
        args: [s.job, date],
      });
      out[step.id] = pickRun(rs.rows as unknown as Raw[]);
    } else if (s.kind === "marker") {
      const marks = s.kinds.map(() => "?").join(", ");
      const rs = await db.execute({
        sql: `SELECT at FROM completion_marker WHERE market = ? AND d = ? AND kind IN (${marks}) ORDER BY at LIMIT 1`,
        args: [market, date, ...s.kinds],
      });
      const at = rs.rows.length ? str(rs.rows[0].at) : null;
      out[step.id] = at === null ? null : { startedAt: at, finishedAt: at, ok: true };
    } else if (s.kind === "email") {
      const rs = await db.execute({
        sql: `SELECT status, created_at, sent_at FROM email_message
              WHERE env = ? AND d = ? AND kind = 'review' ORDER BY created_at`,
        args: [env, date],
      });
      const sent = rs.rows.find((r) => String(r.status) === "sent" && r.sent_at !== null);
      if (sent) {
        out[step.id] = { startedAt: str(sent.created_at), finishedAt: str(sent.sent_at), ok: true };
      } else {
        const bad = rs.rows.find((r) => String(r.status) === "failed");
        out[step.id] = bad ? { startedAt: str(bad.created_at), finishedAt: null, ok: false } : null;
      }
    } else {
      const rs = await db.execute({
        sql: `SELECT started_at, finished_at, status FROM preopen_run WHERE market = ? AND d = ?`,
        args: [market, date],
      });
      const r = rs.rows[0];
      out[step.id] = r
        ? {
            startedAt: str(r.started_at),
            finishedAt: str(r.finished_at),
            ok: String(r.status) !== "error",
          }
        : null;
    }
  }
  return out;
}

async function loadCalendarRows(db: Client, market: string): Promise<CalendarRow[]> {
  const rs = await db.execute({
    sql: "SELECT d, kind, close_time FROM trading_calendar WHERE market = ? ORDER BY d",
    args: [market],
  });
  return rs.rows.map((r) => ({
    d: String(r.d),
    kind: String(r.kind) as CalendarKind,
    close_time: str(r.close_time),
  }));
}

async function readMarketOpen(db: Client): Promise<{ openTime: string; tz: string }> {
  const rs = await db.execute({
    sql: "SELECT tz, open_time FROM market WHERE code = ?",
    args: [DEADLINE_MARKET],
  });
  const r = rs.rows[0];
  return {
    openTime: timeOf(r ? str(r.open_time) : null, "10:00"), // threshold-ok: ASX open, only when the market row is absent
    tz: r ? String(r.tz) : DEADLINE_TZ,
  };
}

/** Reads config, calendar and records and evaluates the day. `env` = email_message env. */
export async function checkDay(
  db: Client,
  date: string,
  now: Date,
  env: string,
): Promise<StepRow[]> {
  const keys = [...new Set(STEPS.flatMap((s) => [s.startKey, s.deadlineKey]))].filter(
    (k): k is ConfigKey => k !== undefined,
  );
  const config: Partial<Record<ConfigKey, unknown>> = {};
  for (const k of keys) config[k] = await getConfig(db, k);
  const { openTime, tz } = await readMarketOpen(db);
  return evaluateDay({
    date,
    calendar: await loadCalendarRows(db, DEADLINE_MARKET),
    observations: await readObservations(db, date, env),
    now,
    openTime,
    config,
    tz,
  });
}

/** Markdown table for a job summary: step names and HH:MM times only. */
export function renderTable(rows: readonly StepRow[]): string {
  const label: Record<DeadlineStatus, string> = {
    on_time: "pass",
    late: "LATE",
    missing: "MISSING",
    not_due: "not due",
  };
  const lines = [
    "| Step | Start | Deadline | Started | Finished | Result | Note |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.label} | ${r.start} | ${r.deadline} | ${r.startedAt ?? "-"} | ${r.finishedAt ?? "-"} | ${label[r.status]} | ${r.reason} |`,
    ),
  ];
  return lines.join("\n");
}
