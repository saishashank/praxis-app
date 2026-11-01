"use client";
// Owner-only "let this cohort carry on" button for a cohort frozen by a fatal ledger verdict (V1-S1,
// D-680..D-682). Opens a confirmation sheet with a required cause; nothing is sent until "Confirm". The
// server action refuses anyone but the Owner whatever this component renders.
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { controlErrorText, type ControlResult } from "./messages";

type Props = {
  cohortId: string;
  throughD: string;
  gapSessions: number;
  action: (fd: FormData) => Promise<ControlResult>;
};

export function ClearFrozenButton({ cohortId, throughD, gapSessions, action }: Props) {
  const [open, setOpen] = useState(false);
  const formId = `clear-frozen-${cohortId}`;
  const [result, run, pending] = useActionState<ControlResult | null, FormData>(
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
      trigger={<>Resume</>}
      triggerClassName="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-semibold text-text hover:bg-surface-2"
      title={`Resume ${cohortId}?`}
      description={`It stopped on ${throughD} after a ledger check failed. Only do this once the cause is fixed. ${
        gapSessions > 0
          ? `${gapSessions} session(s) it missed are replayed for this cohort first. `
          : ""
      }A new failure freezes it again. This is logged.`}
      primary={
        <Button type="submit" form={formId} disabled={pending}>
          Confirm resume
        </Button>
      }
    >
      <form id={formId} action={run} className="flex flex-col gap-3">
        <input type="hidden" name="cohortId" value={cohortId} />
        <input type="hidden" name="confirm" value="true" />
        <label className="flex flex-col gap-1 text-sm">
          <span>What was fixed (required, kept in the audit log)</span>
          <input
            name="cause"
            required
            maxLength={300}
            autoComplete="off"
            className="rounded-md border border-border bg-bg px-2 py-1 text-text"
          />
        </label>
        {result !== null && "error" in result ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {controlErrorText(result.error)}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
