// Ops checklist: the OPS-020 task table and its due dates (UX-118; M7 T19b; docs/M7_design.md decision
// 55; D-148 draft). Pure functions over calendar-date strings (YYYY-MM-DD) in Australia/Melbourne:
// the Melbourne "today" comes from the instant with the zone database (marketDate), so a day that is
// 23 or 25 hours long (the two DST changes) never moves a due date. Weekdays and day counts are done on
// the date digits in UTC, which has no DST. Nothing here reads a clock or a database.
import { addDays, marketDate } from "@/lib/data/calendar";

export const OPS_TZ = "Australia/Melbourne";

const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const WEEK = 7; // threshold-ok: days in a week
const SATURDAY = 6; // threshold-ok: day of week, Sunday = 0
const FIRST_OF_MONTH = 1; // threshold-ok: day of month
const MONTHS_PER_YEAR = 12; // threshold-ok: calendar
const NOVEMBER = 11; // threshold-ok: DAT-160 calendar confirmation month
const QUARTER_MONTHS = [1, 4, 7, 10] as const; // threshold-ok: OPS-020 quarterly restore drill
/** ASIC CFD leverage label review (ARN-049): the review is due the day after 23 May 2027. */
export const ASIC_REVIEW_FROM = "2027-05-24";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly" | "once";

export type OpsTask = {
  id: string;
  cadence: Cadence;
  /** "Weekly (Saturday)" and the like: the OPS-020 wording of when. */
  when: string;
  title: string;
  /** OPS-020 detail line. */
  detail: string;
};

/** Fixed (date-driven) tasks, in the order shown. Token rotations are added per stored expiry date. */
export const FIXED_TASKS: readonly OpsTask[] = [
  {
    id: "weekly_review",
    cadence: "weekly",
    when: "Weekly (Saturday)",
    title: "Weekly review",
    detail:
      "Review the corporate actions in the queue (only conflicts between sources land there), skim the System Health trends, and review challengers awaiting approval.",
  },
  {
    id: "monthly_checks",
    cadence: "monthly",
    when: "Monthly (first Saturday)",
    title: "Monthly checks",
    detail:
      "Re-check source terms in the licence register, confirm the Gmail filter still delivers reviews to the inbox, review the LLM bake-off report and the Usage trends, confirm a $0 bill on every provider, re-verify the GitHub branch protection, fork-approval and secret-scanning settings, and check that a received Evening Review passes SPF and DKIM.",
  },
  {
    id: "offsite_backup",
    cadence: "monthly",
    when: "Monthly (1st, offsite)",
    title: "Offsite backup check",
    detail:
      "Download the latest encrypted backup and history files to storage outside GitHub and not tied to the sign-in Google account, run the local decrypt-only check with the offline key, and tick here.",
  },
  {
    id: "restore_drill",
    cadence: "quarterly",
    when: "Quarterly after go-live (1 Jan, Apr, Jul, Oct)",
    title: "Restore drill",
    detail:
      "Run the restore drill (TST-108), then delete the key secret and revoke the temporary Turso token. The release gate needs a pass within 120 days.",
  },
  {
    id: "calendar_confirm",
    cadence: "yearly",
    when: "Yearly (1 November)",
    title: "Confirm next year's trading calendars",
    detail: "Confirm the drafted trading calendars for the active markets (one click, DAT-160).",
  },
  {
    id: "asic_cfd_review",
    cadence: "once",
    when: "After 23 May 2027",
    title: "ASIC CFD leverage label",
    detail:
      "Re-verify the ASIC retail CFD leverage label (ARN-049). No action needed if the review card says unchanged.",
  },
];

export const ROTATE_PREFIX = "rotate_";

export const isDate = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Melbourne calendar date of an instant (DST-correct). */
export const melbourneToday = (now: Date): string => marketDate(now, OPS_TZ);

const parts = (d: string): { y: number; m: number; day: number } => ({
  y: Number(d.slice(0, 4)),
  m: Number(d.slice(5, 7)),
  day: Number(d.slice(8, 10)),
});
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const ymd = (y: number, m: number, day: number): string => `${pad(y, 4)}-${pad(m)}-${pad(day)}`;
const dayOfWeek = (d: string): number => {
  const p = parts(d);
  return new Date(Date.UTC(p.y, p.m - 1, p.day)).getUTCDay();
};

/** Whole days from a to b (b later = positive), on the date digits. */
export function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.day) - Date.UTC(pa.y, pa.m - 1, pa.day)) / DAY_MS);
}

/** First Saturday of a month. */
export function firstSaturday(y: number, m: number): string {
  const first = ymd(y, m, FIRST_OF_MONTH);
  return addDays(first, (SATURDAY - dayOfWeek(first) + WEEK) % WEEK);
}

function monthShift(y: number, m: number, by: number): { y: number; m: number } {
  const i = y * MONTHS_PER_YEAR + (m - 1) + by;
  return { y: Math.floor(i / MONTHS_PER_YEAR), m: (i % MONTHS_PER_YEAR) + 1 };
}

/** Occurrences of a date-driven task around `today`: the latest on or before it and the next after it. */
export function occurrences(
  task: Pick<OpsTask, "cadence" | "id">,
  today: string,
): { latest: string | null; next: string | null } {
  const { y, m } = parts(today);
  const candidates: string[] = [];
  if (task.cadence === "weekly") {
    const back = (dayOfWeek(today) - SATURDAY + WEEK) % WEEK; // days since the last Saturday
    candidates.push(addDays(today, -back), addDays(today, WEEK - back));
  } else if (task.cadence === "monthly") {
    for (const by of [-1, 0, 1]) {
      const s = monthShift(y, m, by);
      candidates.push(
        task.id === "offsite_backup" ? ymd(s.y, s.m, FIRST_OF_MONTH) : firstSaturday(s.y, s.m),
      );
    }
  } else if (task.cadence === "quarterly") {
    for (const yy of [y - 1, y, y + 1])
      for (const mm of QUARTER_MONTHS) candidates.push(ymd(yy, mm, FIRST_OF_MONTH));
  } else if (task.cadence === "yearly") {
    for (const yy of [y - 1, y, y + 1]) candidates.push(ymd(yy, NOVEMBER, FIRST_OF_MONTH));
  } else {
    candidates.push(ASIC_REVIEW_FROM);
  }
  candidates.sort();
  const latest = [...candidates].reverse().find((c) => c <= today) ?? null;
  const next = candidates.find((c) => c > today) ?? null;
  return { latest, next };
}

export type TaskStatus = "done" | "due" | "overdue" | "upcoming";

export type TaskRow = {
  id: string;
  title: string;
  when: string;
  detail: string;
  /** The occurrence that can be ticked now (latest on or before today); null before the first one. */
  dueD: string | null;
  /** Next occurrence after today, when one exists. */
  nextD: string | null;
  status: TaskStatus;
  /** Whole days past due for "overdue"; 0 otherwise. */
  daysOverdue: number;
  doneAt: string | null;
};

export type DoneRow = { taskId: string; dueD: string; doneAt: string };

export type TokenRow = { name: string; expiresOn: string };

function statusOf(
  dueD: string,
  today: string,
  done: boolean,
): { status: TaskStatus; late: number } {
  if (done) return { status: "done", late: 0 };
  const late = daysBetween(dueD, today);
  return late > 0 ? { status: "overdue", late } : { status: "due", late: 0 };
}

const head = (t: OpsTask): Pick<TaskRow, "id" | "title" | "when" | "detail"> => ({
  id: t.id,
  title: t.title,
  when: t.when,
  detail: t.detail,
});

/**
 * The checklist for one Melbourne day. A task with no occurrence yet (before the one-off date) is
 * "upcoming". A token rotation is due on its stored expiry date and opens on the first warning day
 * (`warnDays` is the SEC-021 list, its largest value opens it); before that it is "upcoming".
 */
export function buildChecklist(
  today: string,
  done: readonly DoneRow[],
  tokens: readonly TokenRow[],
  warnDays: readonly number[],
): TaskRow[] {
  const ticked = new Map(done.map((x) => [`${x.taskId}|${x.dueD}`, x.doneAt]));
  const rows: TaskRow[] = [];
  for (const t of FIXED_TASKS) {
    const o = occurrences(t, today);
    if (o.latest === null) {
      rows.push({
        ...head(t),
        dueD: null,
        nextD: o.next,
        status: "upcoming",
        daysOverdue: 0,
        doneAt: null,
      });
      continue;
    }
    const at = ticked.get(`${t.id}|${o.latest}`) ?? null;
    const s = statusOf(o.latest, today, at !== null);
    rows.push({
      ...head(t),
      dueD: o.latest,
      nextD: o.next,
      status: s.status,
      daysOverdue: s.late,
      doneAt: at,
    });
  }
  const open = Math.max(0, ...warnDays);
  const sorted = [...tokens].sort(
    (a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.name.localeCompare(b.name),
  );
  for (const k of sorted) {
    const id = `${ROTATE_PREFIX}${k.name}`;
    const at = ticked.get(`${id}|${k.expiresOn}`) ?? null;
    const row = {
      id,
      title: `Rotate ${k.name}`,
      when: "Per SEC-021, reminded before the expiry date",
      detail:
        "Rotate the secret with the guided rotation page, then run the smoke test. A rotation is done only when the smoke test passes for every rotated secret.",
    };
    if (at !== null) {
      rows.push({
        ...row,
        dueD: k.expiresOn,
        nextD: null,
        status: "done",
        daysOverdue: 0,
        doneAt: at,
      });
    } else if (daysBetween(today, k.expiresOn) > open) {
      rows.push({
        ...row,
        dueD: null,
        nextD: k.expiresOn,
        status: "upcoming",
        daysOverdue: 0,
        doneAt: null,
      });
    } else {
      const s = statusOf(k.expiresOn, today, false);
      rows.push({
        ...row,
        dueD: k.expiresOn,
        nextD: null,
        status: s.status,
        daysOverdue: s.late,
        doneAt: null,
      });
    }
  }
  return rows;
}

/** The occurrence a tick may name today: exactly the row's `dueD` (a past or future date is refused). */
export function tickableDue(
  taskId: string,
  today: string,
  tokens: readonly TokenRow[],
  warnDays: readonly number[],
): string | null {
  return buildChecklist(today, [], tokens, warnDays).find((r) => r.id === taskId)?.dueD ?? null;
}
