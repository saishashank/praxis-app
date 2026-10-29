// Ops checklist (UX-118, OPS-020; M7 T19b; docs/M7_design.md 3 row 28, decision 55; D-148 draft). Owner
// only. The OPS-020 tasks with their due dates (Melbourne calendar dates, DST-safe), a "Mark done" tick
// per task (append-only, audited) and the token expiry dates. Nothing here is invented: a task shows
// its date, its status and who/when only through the stored tick.
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/States";
import { requireUser } from "@/lib/auth/guard";
import { mainDb } from "@/lib/db/client";
import { loadOps } from "@/lib/ops/service";
import type { TaskRow, TaskStatus } from "@/lib/ops/checklist";
import { formatMelbourne } from "@/lib/health/format";
import { userPreferences } from "@/lib/preferences/read";
import { tickOpsTaskAction } from "./actions";
import { TickButton } from "./TickButton";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC", // the digits are already a Melbourne calendar date; no zone shift wanted
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const dateText = (d: string): string => dateFmt.format(new Date(`${d}T00:00:00Z`));

const STATUS_WORDS: Record<TaskStatus, string> = {
  done: "Done",
  due: "Due",
  overdue: "Overdue",
  upcoming: "Not due yet",
};

const STATUS_PILL: Record<TaskStatus, string> = {
  done: "ok",
  due: "warn",
  overdue: "bad",
  upcoming: "neutral",
};

function statusLine(t: TaskRow, tf: "24h" | "12h"): string {
  if (t.status === "done")
    return `Done${t.doneAt ? ` on ${formatMelbourne(t.doneAt, tf)}` : ""}${
      t.nextD ? `. Next due ${dateText(t.nextD)}.` : "."
    }`;
  if (t.status === "overdue")
    return `Overdue by ${t.daysOverdue} ${t.daysOverdue === 1 ? "day" : "days"} (due ${dateText(t.dueD!)}).`;
  if (t.status === "due") return `Due ${dateText(t.dueD!)}.`;
  return t.nextD ? `Not due yet. Next due ${dateText(t.nextD)}.` : "Not due yet.";
}

function TaskItem({ t, tf }: { t: TaskRow; tf: "24h" | "12h" }) {
  const tickable = (t.status === "due" || t.status === "overdue") && t.dueD !== null;
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-md bg-surface-2 p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="m-0 font-semibold break-words">{t.title}</p>
        <p className="m-0 mt-1">
          <Pill kind="status" value={STATUS_PILL[t.status]}>
            {STATUS_WORDS[t.status]}
          </Pill>
        </p>
        <p className="m-0 text-sm text-text-muted">{t.when}</p>
        <p className="m-0 mt-1 text-sm break-words">{t.detail}</p>
        <p className="m-0 mt-1 text-sm font-medium">{statusLine(t, tf)}</p>
      </div>
      {tickable ? (
        <TickButton task={t.id} due={t.dueD!} title={t.title} action={tickOpsTaskAction} />
      ) : null}
    </li>
  );
}

function Group({
  id,
  title,
  tasks,
  tf,
  empty,
  children,
}: {
  id: string;
  title: string;
  tasks: TaskRow[];
  tf: "24h" | "12h";
  empty: string;
  children: string;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title} <span className="font-normal text-text-muted">({tasks.length})</span>
      </h2>
      {tasks.length === 0 ? (
        <EmptyState title={empty}>{children}</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {tasks.map((t) => (
            <TaskItem key={t.id} t={t} tf={tf} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function OpsPage() {
  const user = await requireUser("admin", "/ops");
  const tf = (await userPreferences(user.id)).time_format;
  let ops: Awaited<ReturnType<typeof loadOps>> | null = null;
  try {
    ops = await loadOps(mainDb(), new Date());
  } catch {
    ops = null; // neutral message below; no error details
  }
  const tasks = ops?.tasks ?? [];
  // UXR-029: three groups. "Due soon" holds what is due now and what is still coming up.
  const overdue = tasks.filter((t) => t.status === "overdue");
  const dueSoon = tasks.filter((t) => t.status === "due" || t.status === "upcoming");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <main className="mx-auto flex max-w-4xl min-w-0 flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Ops checklist</h1>
        <p className="m-0 text-sm text-text-muted">
          Your recurring checks, grouped by what needs you first. Due dates are in
          Australia/Melbourne time.
          {ops ? ` Today is ${dateText(ops.today)}.` : ""}
        </p>
      </header>

      {ops === null ? (
        <p role="status">Ops checklist unavailable. Nothing was changed.</p>
      ) : (
        <>
          <Group id="overdue-h" title="Overdue" tasks={overdue} tf={tf} empty="Nothing is overdue">
            Every task past its date has been ticked.
          </Group>
          <Group id="soon-h" title="Due soon" tasks={dueSoon} tf={tf} empty="Nothing is coming up">
            No task is due or coming up.
          </Group>
          <Group id="done-h" title="Done" tasks={done} tf={tf} empty="Nothing ticked yet">
            Tasks you mark done appear here with the date.
          </Group>

          <Card title="Token expiry dates" className="min-w-0">
            {ops.tokens.length === 0 ? (
              <p className="m-0 text-sm text-text-muted">No token expiry dates are recorded yet.</p>
            ) : (
              <>
                <p className="mt-0 text-sm text-text-muted">
                  Reminders start {Math.max(...ops.warnDays)} days before the date and repeat at{" "}
                  {ops.warnDays.join(", ")} days.
                </p>
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Token expiry dates</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-2 pr-4">
                        Secret
                      </th>
                      <th scope="col" className="py-2 pr-4">
                        Expires
                      </th>
                      <th scope="col" className="py-2">
                        Days left
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.tokens.map((k) => (
                      <tr key={k.name} className="border-t border-border">
                        <th scope="row" className="py-2 pr-4 font-medium break-all">
                          {k.name}
                        </th>
                        <td className="py-2 pr-4">{dateText(k.expiresOn)}</td>
                        <td className="py-2">
                          {k.daysLeft < 0
                            ? `Expired ${-k.daysLeft} ${-k.daysLeft === 1 ? "day" : "days"} ago`
                            : k.daysLeft}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
