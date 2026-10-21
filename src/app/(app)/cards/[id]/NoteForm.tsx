"use client";
// Note form of the Decision Card (Owner and Editor only; the server refuses everyone else). The card is
// sent as the reference from the page address, never as a stored id, so a masked user's page never holds
// a code. The shown text of the result is a fixed message for a returned code.
import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { noteErrorText, type NoteResult } from "./messages";

export function NoteForm({
  cardRef,
  action,
}: {
  cardRef: string;
  action: (fd: FormData) => Promise<NoteResult>;
}) {
  const [state, run, pending] = useActionState<NoteResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  const form = useRef<HTMLFormElement>(null);
  const done = state !== null && "ok" in state;
  useEffect(() => {
    if (done) form.current?.reset();
  }, [done, state]);
  return (
    <form ref={form} action={run} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="ref" value={cardRef} />
      <label htmlFor="card-note-text" className="text-sm font-medium">
        Add a note
      </label>
      <textarea
        id="card-note-text"
        name="text"
        required
        maxLength={1000}
        rows={3}
        className="w-full rounded-md border border-border bg-bg p-2 text-text"
      />
      {state !== null && "error" in state ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {noteErrorText(state.error)}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="m-0 text-sm text-text-muted">
          Note saved.
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          Save note
        </Button>
      </div>
    </form>
  );
}
