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
};

export function WorkerSlotsForm({ action, slots, initial }: Props) {
  const [ticked, setTicked] = useState(false);
  const [state, run, pending] = useActionState<Result | null, FormData>(async (_prev, fd) => {
    const result = await action(fd);
    if ("ok" in result) setTicked(false);
    return result;
  }, null);
  return (
    <form action={run} className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Go-live slots (Australia/Sydney time)</legend>
        {slots.map((s) => (
          <label key={s.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="slot"
              value={s.id}
              defaultChecked={initial.includes(s.id)}
            />
            <span title={s.id}>
              <span className="font-mono text-xs">{s.time}</span> {s.label}
            </span>
          </label>
        ))}
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
        className="w-fit rounded border px-2 py-0.5 text-xs"
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
