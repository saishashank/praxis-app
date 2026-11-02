"use client";
// Mute one armed alert (UXN-303). A form post to the server action, so it works without JavaScript.
import { useActionState } from "react";
import { errorText, type ActionResult } from "@/lib/users/messages";

export function MuteButton({
  action,
  alertId,
  stock,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  alertId: string;
  stock: string;
}) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    (_p, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="inline-flex items-center gap-2">
      <input type="hidden" name="alert_id" value={alertId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Mute the alert for ${stock}`}
        className="min-h-9 rounded border px-3 py-1 text-xs font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : "Mute"}
      </button>
      {state !== null && "error" in state ? (
        <span role="alert" className="text-xs text-red-700">
          {errorText(state.error)}
        </span>
      ) : null}
    </form>
  );
}

/** "Alerts for all picks" on or off (the user's own `pick_alerts` preference). */
export function AllPicksToggle({
  action,
  on,
}: {
  action: (fd: FormData) => Promise<ActionResult>;
  on: boolean;
}) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    (_p, fd) => action(fd),
    null,
  );
  return (
    <form
      action={run}
      className="flex flex-wrap items-center gap-3 text-sm"
      data-testid="all-picks"
    >
      <span>
        Alerts for all picks: <strong>{on ? "On" : "Off"}</strong>
      </span>
      <input type="hidden" name="pick_alerts" value={on ? "off" : "on"} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-9 rounded border px-3 py-1 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : on ? "Turn off" : "Turn on"}
      </button>
      {state !== null && "error" in state ? (
        <span role="alert" className="text-red-700">
          {errorText(state.error)}
        </span>
      ) : null}
    </form>
  );
}
