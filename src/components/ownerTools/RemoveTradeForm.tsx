"use client";
// "Remove" on one trade (M21 B2, D-1221): a reason is required; the row stays in the log, marked removed.
import { useActionState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

export function RemoveTradeForm({
  action,
  tradeId,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  tradeId: number;
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="mt-2 flex flex-wrap items-center gap-2" data-testid="remove-form">
      <input type="hidden" name="trade_id" value={tradeId} />
      <input
        name="reason"
        maxLength={200}
        required
        aria-label="Why remove this trade"
        placeholder="Why remove it?"
        className="min-h-9 min-w-0 flex-1 rounded border px-2 py-1 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded border px-3 py-1 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {state !== null && "error" in state ? (
        <p role="alert" className="m-0 w-full text-sm text-red-700">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
