"use client";
// One-click calendar confirmation (DAT-160). Shown to the Owner only; the action re-checks the role.
import { useActionState } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; rows: number } | { error: string };

type Props = {
  action: (fd: FormData) => Promise<Result>;
  market: string;
  year: number;
};

export function CalendarConfirmForm({ action, market, year }: Props) {
  const [state, run] = useActionState<Result | null, FormData>((_prev, fd) => action(fd), null);
  return (
    <form action={run} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="market" value={market} />
      <input type="hidden" name="year" value={year} />
      <button type="submit" className="rounded border px-2 py-0.5 text-xs">
        Confirm {market} {year} calendar
      </button>
      {state !== null && "error" in state && (
        <span role="alert" className="text-sm text-red-700">
          {errorText(state.error)}
        </span>
      )}
      {state !== null && "ok" in state && (
        <span role="status" className="text-sm">
          Confirmed.
        </span>
      )}
    </form>
  );
}
