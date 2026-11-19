"use client";
// The amount the Owner sizes against (M21 B1, UXN-315, D-1217). A whole number of home-currency units; 0 clears it. The
// server action checks it again. No credential is asked for here or anywhere in the Owner tools (AT-78).
import { useActionState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

export function CapitalForm({
  action,
  current,
  symbol,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  current: number;
  symbol: string;
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-2" data-testid="capital-form">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Amount you would invest in total ({symbol}, whole numbers)
        </span>
        <input
          type="text"
          inputMode="numeric"
          name="real_capital"
          defaultValue={current > 0 ? String(current) : ""}
          placeholder="For example 10000"
          className="min-h-9 w-48 rounded border px-2 py-1"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save amount"}
        </button>
        {state !== null && "ok" in state ? (
          <p role="status" className="m-0 text-sm">
            Saved.
          </p>
        ) : null}
        {state !== null && "error" in state ? (
          <p role="alert" className="m-0 text-sm text-red-700">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
