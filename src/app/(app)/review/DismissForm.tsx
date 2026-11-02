"use client";
// Dismiss button of one steelman suggestion (M11-lite WP6; D-492). Owner only; the action re-checks.
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";

type Result = { ok: true } | { error: string };

const TEXT: Record<string, string> = {
  not_open: "That suggestion is already closed.",
  not_found: "That suggestion no longer exists.",
  forbidden: "You do not have access to do that.",
  invalid: "Please try again.",
  unavailable: "Something went wrong. Please try again.",
};

export function DismissForm({
  id,
  code,
  dismiss,
}: {
  id: string;
  code: string;
  dismiss: (fd: FormData) => Promise<Result>;
}) {
  const [state, run] = useActionState<Result | null, FormData>((_p, fd) => dismiss(fd), null);
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" aria-label={`Dismiss the suggestion for ${code}`}>
        Dismiss
      </Button>
      {state !== null && "error" in state && (
        <span role="alert" className="min-w-0 text-sm text-danger">
          {TEXT[state.error] ?? TEXT.unavailable}
        </span>
      )}
    </form>
  );
}
