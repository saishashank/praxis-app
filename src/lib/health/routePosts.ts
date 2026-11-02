// System Health: Worker route posts per slot per day (V2-I4, D-773) and the "last 7 nights" table
// (V1-I1, D-770 .. D-771). The Worker records a failed signed POST as a `worker-route` run record
// (D-668) with `details_json = {slot, ...}` and `scheduled_for` = the Sydney date. There is no success
// record for a recurring slot (quote_run carries those, D-698), so this reads FAILURES only: a slot with
// no failed post is shown as "-" (no failure recorded), never as "ok".
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { melbourneDate } from "@/lib/view/active";
import { checkDay, STEPS, type DeadlineStatus, type StepRow } from "@/lib/runs/deadlines";

export const ROUTE_JOB = "worker-route";
export const NIGHTS = 7; // threshold-ok: "last 7 nights" per V1-I1

export type RouteFailure = { slot: string; date: string; count: number; last: string };

type Exec = Pick<Client, "execute">;

/** Failed route posts per (slot, date) from `fromDate` on, newest detail kept (read-only). */
export async function routeFailuresSince(db: Exec, fromDate: string): Promise<RouteFailure[]> {
  const rs = await db.execute({
    sql:
      "SELECT scheduled_for, error_summary, details_json FROM run_record " +
      "WHERE job = ? AND status = 'failed' AND scheduled_for >= ? ORDER BY started_at, id",
    args: [ROUTE_JOB, fromDate],
  });
  const m = new Map<string, RouteFailure>();
  for (const r of rs.rows) {
    let slot = "unknown";
    try {
      const d: unknown = JSON.parse(String(r.details_json ?? "{}"));
      if (d && typeof d === "object" && typeof (d as { slot?: unknown }).slot === "string") {
        slot = (d as { slot: string }).slot;
      }
    } catch {
      // keep "unknown"
    }
    const date = String(r.scheduled_for);
    const key = `${slot}|${date}`;
    const prev = m.get(key);
    const last = String(r.error_summary ?? "").slice(0, 120);
    m.set(key, { slot, date, count: (prev?.count ?? 0) + 1, last });
  }
  return [...m.values()];
}

/** One line per slot with failed posts on `date`; empty when none (pure). */
export function routeLinesOf(failures: readonly RouteFailure[], date: string): string[] {
  return failures
    .filter((f) => f.date === date)
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map(
      (f) =>
        `Worker route ${f.slot}: ${f.count} failed post${f.count === 1 ? "" : "s"} today` +
        (f.last ? ` (${f.last})` : ""),
    );
}

/** Owner lines for today (Melbourne and Sydney share the date). Throws on DB failure. */
export async function workerRouteLines(db: Exec, now: Date): Promise<string[]> {
  const today = melbourneDate(now.toISOString()) ?? "";
  return routeLinesOf(await routeFailuresSince(db, today), today);
}

// ---- the table -------------------------------------------------------------------------------------

export type NightCell = { date: string; text: string; bad: boolean };
export type NightsRow = { id: string; label: string; kind: "step" | "route"; cells: NightCell[] };
export type NightsTable = { dates: string[]; rows: NightsRow[] };

const STEP_TEXT: Record<DeadlineStatus, string> = {
  on_time: "on time",
  late: "LATE",
  missing: "MISSING",
  not_due: "-",
};

/** Pure: the last-N-nights matrix. `days` is oldest first; one row per PLT-073 step, then per failing slot. */
export function buildNights(
  days: readonly { date: string; rows: readonly StepRow[] }[],
  failures: readonly RouteFailure[],
): NightsTable {
  const dates = days.map((d) => d.date);
  const rows: NightsRow[] = STEPS.map((step) => ({
    id: step.id,
    label: step.label,
    kind: "step",
    cells: days.map((d) => {
      const r = d.rows.find((x) => x.id === step.id);
      const status = r?.status ?? "not_due";
      return {
        date: d.date,
        text: STEP_TEXT[status],
        bad: status === "late" || status === "missing",
      };
    }),
  }));
  const slots = [
    ...new Set(failures.filter((f) => dates.includes(f.date)).map((f) => f.slot)),
  ].sort();
  for (const slot of slots) {
    rows.push({
      id: `route:${slot}`,
      label: `Worker route post: ${slot}`,
      kind: "route",
      cells: dates.map((date) => {
        const f = failures.find((x) => x.slot === slot && x.date === date);
        return f ? { date, text: `${f.count} failed`, bad: true } : { date, text: "-", bad: false };
      }),
    });
  }
  return { dates, rows };
}

/** Reads the seven nights up to today. Throws on DB failure (the caller shows a neutral line). */
export async function loadNights(db: Client, now: Date, emailEnv: string): Promise<NightsTable> {
  const today = melbourneDate(now.toISOString()) ?? "";
  const dates = Array.from({ length: NIGHTS }, (_, i) => addDays(today, i - (NIGHTS - 1)));
  const days: { date: string; rows: Awaited<ReturnType<typeof checkDay>> }[] = [];
  for (const date of dates) days.push({ date, rows: await checkDay(db, date, now, emailEnv) });
  return buildNights(days, await routeFailuresSince(db, dates[0]));
}
