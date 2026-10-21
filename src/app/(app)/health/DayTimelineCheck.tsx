// System Health "Day timeline check" (M8 T12; docs/M8_design.md 2.2, decision 45; TST-106, PLT-073).
// Owner only. Shows today's PLT-073 deadline check from the records the jobs already wrote: the
// same function the staging E2E day uses (src/lib/runs/deadlines.ts). It only reads; there is no
// form and no write path. A failed read shows a neutral line, never the error.
import { emailEnvName } from "@/lib/email/send";
import { mainDb } from "@/lib/db/client";
import { checkDay, dayPasses, type DeadlineStatus, type StepRow } from "@/lib/runs/deadlines";
import { melbourneDate } from "@/lib/view/active";

const RESULT_LABEL: Record<DeadlineStatus, string> = {
  on_time: "On time",
  late: "LATE",
  missing: "MISSING",
  not_due: "Not due",
};

/** The card body: a plain table of step names and HH:MM times. */
export function DayTimelineView({ date, rows }: { date: string; rows: StepRow[] | null }) {
  return (
    <section aria-labelledby="day-timeline-h" className="flex flex-col gap-3">
      <h2 id="day-timeline-h" className="text-xl font-semibold">
        Day timeline check
      </h2>
      {rows === null ? (
        <p role="status" className="text-sm text-text-muted">
          The day timeline is unavailable.
        </p>
      ) : (
        <>
          <p role="status" className="text-sm">
            <span className="rounded border px-2 py-0.5 font-mono text-xs">
              {dayPasses(rows) ? "OK so far" : "ATTENTION"}
            </span>
            <span className="ml-2 text-text-muted">
              {date}. Each step is checked against the time the next one starts (PLT-073). Times are
              Australia/Melbourne.
            </span>
          </p>
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">Deadline check for {date}</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-4">
                  Step
                </th>
                <th scope="col" className="py-2 pr-4">
                  Deadline
                </th>
                <th scope="col" className="py-2 pr-4">
                  Finished
                </th>
                <th scope="col" className="py-2 pr-4">
                  Result
                </th>
                <th scope="col" className="py-2">
                  Note
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <th scope="row" className="py-2 pr-4 font-medium">
                    {r.label}
                  </th>
                  <td className="py-2 pr-4">{r.deadline}</td>
                  <td className="py-2 pr-4">{r.finishedAt ?? "-"}</td>
                  <td className="py-2 pr-4">
                    <span className="rounded border px-2 py-0.5 font-mono text-xs">
                      {RESULT_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="py-2 text-text-muted">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export async function DayTimelineCheck({ owner }: { owner: boolean }) {
  if (!owner) return null;
  const now = new Date();
  const date = melbourneDate(now.toISOString()) ?? "";
  let rows: StepRow[] | null = null;
  try {
    rows = await checkDay(mainDb(), date, now, emailEnvName(process.env));
  } catch {
    rows = null; // neutral message in the view; no error details
  }
  return <DayTimelineView date={date} rows={rows} />;
}
