"use client";
// The Picks order toggle (UXN-309): "Sort by expected gain" / "Sort by chance", remembered per user.
// Works without JavaScript (a form post); the server action stores `picks_sort` for the signed-in user only.
import { useActionState } from "react";
import { errorText, type ActionResult } from "@/lib/users/messages";

export function SortToggle({
  action,
  current,
  words,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  current: "chance" | "expected_gain";
  words: { basis: string; toggle: string };
}) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    (_p, fd) => action(fd),
    null,
  );
  const next = current === "chance" ? "expected_gain" : "chance";
  return (
    <form
      action={run}
      className="flex flex-wrap items-center gap-3 text-sm"
      data-testid="sort-toggle"
    >
      <span data-testid="sort-basis" className="text-text-muted">
        {words.basis}
      </span>
      <input type="hidden" name="picks_sort" value={next} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-9 rounded border px-3 py-1 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : words.toggle}
      </button>
      {state !== null && "error" in state ? (
        <span role="alert" className="text-red-700">
          {errorText(state.error)}
        </span>
      ) : null}
    </form>
  );
}
