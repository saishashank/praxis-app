"use client";
// The Owner's "accept the risk" control for one expert source (M22 E1; D-1472). One small form that posts to the
// server action; the server re-checks the role and writes the audit row. A refusal is shown in words.
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import type { AcceptRiskResult } from "./actions";

type Act = (fd: FormData) => Promise<AcceptRiskResult>;

const TEXT: Record<string, string> = {
  invalid: "Please check the source and try again.",
  forbidden: "Only the Owner can accept this risk.",
  not_found: "That source no longer exists.",
  not_checked: "The source has not been checked yet, so there is nothing to accept.",
  robots: "The site's robots file asks automated readers to stay away; that cannot be accepted.",
  not_needed: "This source is already allowed.",
  unavailable: "Something went wrong. Please try again.",
};

export function AcceptRisk({
  action,
  expertId,
  sourceKey,
  label,
}: {
  action: Act;
  expertId: string;
  sourceKey: string;
  /** What the control is called for a screen reader (no source name when text is hidden). */
  label: string;
}) {
  const [state, run] = useActionState<AcceptRiskResult | null, FormData>(
    (_p, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-2">
      <input type="hidden" name="expert" value={expertId} />
      <input type="hidden" name="source" value={sourceKey} />
      <Button type="submit" variant="secondary" aria-label={label}>
        Accept the risk
      </Button>
      {state === null ? null : "error" in state ? (
        <span role="alert" className="min-w-0 text-sm text-danger">
          {TEXT[state.error] ?? TEXT.unavailable}
        </span>
      ) : (
        <span role="status" className="min-w-0 text-sm text-text-muted">
          Saved.
        </span>
      )}
    </form>
  );
}
