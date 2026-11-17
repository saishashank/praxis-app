"use client";
// The Owner's three buttons for one discovery candidate (M22 E2; UXN-296, D-1480): approve, dismiss, snooze for 90 days.
// One small form that posts to the server action; the server re-checks the role and writes the audit row. A refusal is
// shown in words.
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import type { CandidateActionResult } from "./actions";

type Act = (fd: FormData) => Promise<CandidateActionResult>;

const TEXT: Record<string, string> = {
  invalid: "Please check the request and try again.",
  forbidden: "Only the Owner can decide this.",
  not_found: "That person is no longer listed.",
  not_a_candidate: "This person has already been decided.",
  full: "The tracked list is full. Retire someone or raise the limit first.",
  unavailable: "Something went wrong. Please try again.",
};

export function CandidateForm({ action, expertId }: { action: Act; expertId: string }) {
  const [state, run] = useActionState<CandidateActionResult | null, FormData>(
    (_p, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-2">
      <input type="hidden" name="expert" value={expertId} />
      <Button type="submit" name="action" value="approve">
        Approve
      </Button>
      <Button type="submit" name="action" value="dismiss" variant="secondary">
        Dismiss
      </Button>
      <Button type="submit" name="action" value="snooze" variant="ghost">
        Snooze 90 days
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
