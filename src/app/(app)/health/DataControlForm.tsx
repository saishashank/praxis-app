"use client";
// One Owner control with a confirmation step (M2 T10). The first button only opens a panel that
// explains what will happen; nothing is sent until "Confirm" is pressed (and, for a risk
// acceptance, the box is ticked). Shown to the Owner only; the action re-checks the role.
import { useActionState, useState } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; changed: boolean } | { error: string };

export type ControlInput = {
  name: string;
  label: string;
  type: "text" | "date" | "number" | "select";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  min?: number;
  max?: number;
  required?: boolean;
};

type Props = {
  action: (fd: FormData) => Promise<Result>;
  /** Hidden form fields sent with the action (for example enabled=1). */
  fields: Record<string, string>;
  /** The button that opens the confirmation panel. */
  label: string;
  /** Plain-English explanation shown in the panel. */
  explain: string;
  /** When set, a box with this text must be ticked before Confirm works (risk acceptance). */
  checkbox?: string;
  confirmLabel?: string;
  /** Fields the Owner fills in inside the confirmation panel (M5 controls). */
  inputs?: ControlInput[];
};

export function DataControlForm({
  action,
  fields,
  label,
  explain,
  checkbox,
  confirmLabel = "Confirm",
  inputs,
}: Props) {
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [state, run] = useActionState<Result | null, FormData>(async (_prev, fd) => {
    const result = await action(fd);
    if ("ok" in result) {
      setOpen(false);
      setTicked(false);
    }
    return result;
  }, null);

  return (
    <form action={run} className="flex flex-col gap-2">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-fit rounded border px-2 py-0.5 text-xs"
        >
          {label}
        </button>
      ) : (
        <div role="group" aria-label={`Confirm: ${label}`} className="rounded border p-3 text-sm">
          <p>{explain}</p>
          {inputs?.map((i) => (
            <label key={i.name} className="mt-2 flex flex-col gap-1">
              <span>{i.label}</span>
              {i.type === "select" ? (
                <select
                  name={i.name}
                  defaultValue={i.defaultValue}
                  required={i.required}
                  className="w-fit rounded border px-2 py-0.5"
                >
                  {i.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={i.name}
                  type={i.type}
                  defaultValue={i.defaultValue}
                  min={i.min}
                  max={i.max}
                  required={i.required}
                  className="w-fit rounded border px-2 py-0.5"
                />
              )}
            </label>
          ))}
          {checkbox !== undefined && (
            <label className="mt-2 flex items-start gap-2">
              <input
                type="checkbox"
                name="acknowledged"
                checked={ticked}
                onChange={(e) => setTicked(e.target.checked)}
              />
              <span>{checkbox}</span>
            </label>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={checkbox !== undefined && !ticked}
              className="rounded border px-2 py-0.5 text-xs"
            >
              {confirmLabel}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTicked(false);
              }}
              className="rounded border px-2 py-0.5 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {state !== null && "error" in state && (
        <span role="alert" className="text-sm text-red-700">
          {errorText(state.error)}
        </span>
      )}
      {state !== null && "ok" in state && (
        <span role="status" className="text-sm">
          {state.changed ? "Done." : "Nothing to change."}
        </span>
      )}
    </form>
  );
}
