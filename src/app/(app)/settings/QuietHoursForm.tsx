"use client";
// Quiet hours (UXN-160): a Melbourne-time window that may wrap midnight. Save sets it, "Turn off"
// clears it. P0 and the regime-shift P1 are never silenced (D-101); the server re-validates.
import { useActionState } from "react";
import { errorText, type ActionResult } from "@/lib/users/messages";

type Props = {
  action: (fd: FormData) => Promise<ActionResult>;
  start: string | null;
  end: string | null;
};

export function QuietHoursForm({ action, start, end }: Props) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Quiet from</span>
          <input
            type="time"
            name="quiet_start"
            defaultValue={start ?? "22:00"}
            required
            className="min-h-9 rounded border px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Quiet until</span>
          <input
            type="time"
            name="quiet_end"
            defaultValue={end ?? "07:00"}
            required
            className="min-h-9 rounded border px-2 py-1"
          />
        </label>
      </div>
      <p className="text-xs text-text-muted">
        Melbourne time. Important (P1) and for-information (P2) alerts stay out of the bell count in
        this window; they are still listed in the inbox. Urgent (P0) alerts are always delivered.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Working…" : "Save quiet hours"}
        </button>
        <button
          type="submit"
          name="quiet_off"
          value="1"
          formNoValidate
          disabled={pending}
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          Turn off
        </button>
        {state !== null && "ok" in state && (
          <p role="status" className="text-sm">
            Saved.
          </p>
        )}
        {state !== null && "error" in state && (
          <p role="alert" className="text-sm text-red-700">
            {errorText(state.error)}
          </p>
        )}
      </div>
      <p className="text-sm" data-testid="quiet-state">
        {start && end ? `Quiet hours are on: ${start} to ${end}.` : "Quiet hours are off."}
      </p>
    </form>
  );
}
