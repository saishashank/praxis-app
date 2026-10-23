"use client";
// The Worker slots switch (M8 T11, Owner only). Nothing is sent until the confirmation box is ticked
// and "Save the list" is pressed; the server action re-checks the Owner and validates every id.
import { useActionState, useState } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; changed: boolean } | { error: string };
type Slot = { id: string; time: string; label: string };

type Props = {
  action: (fd: FormData) => Promise<Result>;
  slots: Slot[];
  initial: string[];
  /** Slots that always run (shown as locked tiles, not part of the form). */
  alwaysOn?: readonly string[];
};

export function WorkerSlotsForm({ action, slots, initial, alwaysOn = [] }: Props) {
  const [ticked, setTicked] = useState(false);
  const [state, run, pending] = useActionState<Result | null, FormData>(async (_prev, fd) => {
    const result = await action(fd);
    if ("ok" in result) setTicked(false);
    return result;
  }, null);
  return (
    <form action={run} className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Go-live slots (Australia/Sydney time)</legend>
        {/* D-174: a grid of slot tiles; a ticked tile is filled, edged and says "On". */}
        <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {slots.map((s) => (
            <label
              key={s.id}
              className="group/slot flex min-h-16 cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-surface-2 has-[:checked]:shadow-[0_0_0_1px_var(--color-accent)]"
            >
              <input
                type="checkbox"
                name="slot"
                value={s.id}
                defaultChecked={initial.includes(s.id)}
                aria-label={`${s.time} ${s.label}`}
                className="mt-1"
              />
              <span title={s.id} className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-base font-semibold">{s.time}</span>
                  <span
                    aria-hidden="true"
                    className="rounded-full border border-border px-2 text-[0.7rem] font-semibold text-text-muted group-has-[:checked]/slot:border-accent group-has-[:checked]/slot:text-text"
                  >
                    <span className="group-has-[:checked]/slot:hidden">Off</span>
                    <span className="hidden group-has-[:checked]/slot:inline">✓ On</span>
                  </span>
                </span>
                <span className="text-text">{s.label}</span>
              </span>
            </label>
          ))}
          {alwaysOn.map((id) => (
            <div
              key={id}
              className="flex min-h-16 items-start gap-3 rounded-lg border border-dashed border-border p-3 text-sm"
            >
              <span aria-hidden="true" className="mt-0.5">
                🔒
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-mono text-xs text-text-muted">{id}</span>
                <span className="text-text-muted">Always on</span>
              </span>
            </div>
          ))}
        </div>
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="confirm"
          value="yes"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
        />
        <span>
          Save only the ticked slots. The Worker may start just these. This goes in the audit log.
        </span>
      </label>
      <button
        type="submit"
        disabled={!ticked || pending}
        className="min-h-10 w-fit rounded-md bg-accent px-4 text-sm font-semibold text-accent-contrast disabled:opacity-50"
      >
        Save the list
      </button>
      {state !== null && "error" in state && (
        <span role="alert" className="text-sm text-red-700">
          {errorText(state.error)}
        </span>
      )}
      {state !== null && "ok" in state && (
        <span role="status" className="text-sm">
          {state.changed ? "Saved." : "Nothing to change."}
        </span>
      )}
    </form>
  );
}
