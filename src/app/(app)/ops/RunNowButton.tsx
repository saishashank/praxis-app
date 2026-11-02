"use client";
// Owner-only "Run now" button of one scheduled job (D-840..D-849). Opens a confirmation sheet (with a
// date picker for the jobs that take a date); nothing is sent until "Confirm". The server action
// refuses anyone but the Owner and checks the job and the date again, whatever this component shows.
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { runNowErrorText, type RunNowResult } from "./messages";

type Props = {
  job: string;
  title: string;
  /** Today's Melbourne date, the default of the picker. */
  today: string;
  /** Earliest pickable date; null when the job takes no date. */
  minDate: string | null;
  disabled: boolean;
  action: (fd: FormData) => Promise<RunNowResult>;
};

export function RunNowButton({ job, title, today, minDate, disabled, action }: Props) {
  const [open, setOpen] = useState(false);
  const formId = `run-now-${job}`;
  const [result, run, pending] = useActionState<RunNowResult | null, FormData>(
    async (_prev, fd) => {
      const r = await action(fd);
      if ("ok" in r) setOpen(false);
      return r;
    },
    null,
  );
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      trigger={
        <>
          Run now<span className="sr-only"> {title}</span>
        </>
      }
      triggerClassName="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2"
      title={`Run ${title} now?`}
      description={
        disabled
          ? "A request for this job is already waiting. Please wait for it to finish."
          : "The Worker starts it within a minute. The usual safety checks still apply: if one says no, the job is not run and the reason is shown here. The usual schedule does not change. This is logged."
      }
      primary={
        <Button type="submit" form={formId} disabled={pending || disabled}>
          Confirm run now
        </Button>
      }
    >
      <form id={formId} action={run} className="flex flex-col gap-3">
        <input type="hidden" name="job" value={job} />
        <input type="hidden" name="confirm" value="true" />
        {minDate !== null ? (
          <label className="flex flex-col gap-1 text-sm">
            <span>Day to run it for</span>
            <input
              type="date"
              name="d"
              defaultValue={today}
              min={minDate}
              max={today}
              required
              className="rounded-md border border-border bg-bg px-2 py-1 text-text"
            />
          </label>
        ) : null}
        {result !== null && "error" in result ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {runNowErrorText(result.error)}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
