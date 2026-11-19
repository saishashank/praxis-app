"use client";
// Mute or unmute one alert (UXN-303, UXN-322, D-1207). A form post to the server action, so it works without
// JavaScript. With JavaScript, a success shows a toast with Undo, and Undo runs the opposite action.
import { useActionState } from "react";
import { useToast } from "@/components/ui/Toast";
import { errorText, type ActionResult } from "@/lib/users/messages";

type Act = (fd: FormData) => Promise<ActionResult>;

/** Words for the two refusals only unmute has; every other code uses the shared text. */
const UNMUTE_ERROR: Record<string, string> = {
  alerts_off: "Turn on alerts for all picks first.",
  not_listed: "That pick is no longer on the list, so its alert cannot come back.",
};
const failText = (code: string): string => UNMUTE_ERROR[code] ?? errorText(code);

/** The toast needs the shell's provider; a page rendered without it (a test) simply shows no toast. */
function useOptionalToast(): ReturnType<typeof useToast> | null {
  try {
    return useToast();
  } catch {
    return null;
  }
}

const formOf = (alertId: string): FormData => {
  const fd = new FormData();
  fd.set("alert_id", alertId);
  return fd;
};

export function MuteButton({
  action,
  undoAction,
  alertId,
  stock,
}: {
  action: Act;
  /** The opposite action, run by the toast's Undo (optional). */
  undoAction?: Act;
  alertId: string;
  stock: string;
}) {
  const toast = useOptionalToast();
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(async (_p, fd) => {
    const r = await action(fd);
    if ("ok" in r) {
      toast?.toast(`Muted the alert for ${stock}`, {
        undo: undoAction ? () => void undoAction(formOf(alertId)) : undefined,
      });
    }
    return r;
  }, null);
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
          {failText(state.error)}
        </span>
      ) : null}
    </form>
  );
}

/** The "Muted" chip of an alert the user muted, with Unmute (UXN-322); a toast with Undo re-mutes. */
export function UnmuteButton({
  action,
  undoAction,
  alertId,
  stock,
}: {
  action: Act;
  /** The opposite action (mute), run by the toast's Undo (optional). */
  undoAction?: Act;
  alertId: string;
  stock: string;
}) {
  const toast = useOptionalToast();
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(async (_p, fd) => {
    const r = await action(fd);
    if ("ok" in r) {
      toast?.toast(`Unmuted the alert for ${stock}`, {
        undo: undoAction ? () => void undoAction(formOf(alertId)) : undefined,
      });
    }
    return r;
  }, null);
  return (
    <form action={run} className="inline-flex items-center gap-2" data-testid="unmute-form">
      <input type="hidden" name="alert_id" value={alertId} />
      <span
        data-testid="muted-chip"
        className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted"
      >
        Muted
      </span>
      <button
        type="submit"
        disabled={pending}
        aria-label={`Unmute the alert for ${stock}`}
        className="min-h-9 rounded border px-3 py-1 text-xs font-medium disabled:opacity-60"
      >
        {pending ? "Working…" : "Unmute"}
      </button>
      {state !== null && "error" in state ? (
        <span role="alert" className="text-xs text-red-700">
          {failText(state.error)}
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
