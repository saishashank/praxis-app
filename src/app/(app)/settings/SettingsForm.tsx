"use client";
// Form wrapper for the personal preferences action: shows "Saved." or the error text.
import { useActionState, type ReactNode } from "react";
import { errorText, type ActionResult } from "@/lib/users/messages";

type Props = { action: (fd: FormData) => Promise<ActionResult>; children: ReactNode };

export function SettingsForm({ action, children }: Props) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-6">
      {children}
      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Working…" : "Save"}
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
    </form>
  );
}
