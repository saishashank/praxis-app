"use client";
// Confirm / Reject buttons for one queued corporate action (UX-114). Shown to the Owner only; the
// actions re-check the role.
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";

type Result = { ok: true } | { error: string };
type Props = {
  id: number;
  /** Stock code, for the accessible name of the one Apply button. */
  code?: string;
  confirm: (fd: FormData) => Promise<Result>;
  reject: (fd: FormData) => Promise<Result>;
};

const TEXT: Record<string, string> = {
  not_open: "That item is no longer waiting for a decision.",
  not_found: "That item no longer exists.",
  conflicts_with_confirmed: "Another reading of this event is already confirmed. Reject this one.",
  forbidden: "You do not have access to do that.",
  invalid: "Please try again.",
  unavailable: "Something went wrong. Please try again.",
};

export function ReviewForm({ id, code = "this item", confirm, reject }: Props) {
  const [state, run] = useActionState<Result | null, FormData>(
    (_prev, fd) => (fd.get("decision") === "reject" ? reject(fd) : confirm(fd)),
    null,
  );
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        name="decision"
        value="confirm"
        aria-label={`Apply the reported reading for ${code}`}
      >
        Apply
      </Button>
      <Button type="submit" name="decision" value="reject" variant="ghost">
        Reject
      </Button>
      {state !== null && "error" in state && (
        <span role="alert" className="min-w-0 text-sm text-danger">
          {TEXT[state.error] ?? TEXT.unavailable}
        </span>
      )}
      {state !== null && "ok" in state && (
        <span role="status" className="text-sm">
          Done.
        </span>
      )}
    </form>
  );
}
