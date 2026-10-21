"use client";
// The go-live checklist and sign-off form (M8 T11, Owner only). The button stays disabled until every
// item is ticked and the exact phrase is typed; the server action checks both again and refuses
// anything else. Nothing here switches the market mode.
import { useActionState, useState } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; changed: boolean } | { error: string };
type Item = { id: string; label: string; help: string };

type Props = {
  action: (fd: FormData) => Promise<Result>;
  items: Item[];
  phrase: string;
  noteMax: number;
  /** True when the deployment does not report its commit: the Owner types it. */
  askCommit: boolean;
};

export function GoLiveForm({ action, items, phrase, noteMax, askCommit }: Props) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [typed, setTyped] = useState("");
  const all = items.every((i) => ticked[i.id] === true);
  const [state, run, pending] = useActionState<Result | null, FormData>(
    async (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">
          Tick each item once you have done it yourself
        </legend>
        {items.map((i) => (
          <label key={i.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="item"
              value={i.id}
              checked={ticked[i.id] === true}
              onChange={(e) => setTicked({ ...ticked, [i.id]: e.target.checked })}
            />
            <span>
              <span className="font-medium">{i.label}</span>
              <span className="block text-text-muted">{i.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {askCommit && (
        <label className="flex flex-col gap-1 text-sm">
          <span>Release commit (7 to 64 letters a-f and digits)</span>
          <input
            name="commit"
            type="text"
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            className="w-full max-w-md rounded border px-2 py-1 font-mono"
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span>Note (optional, at most {noteMax} characters)</span>
        <textarea
          name="note"
          maxLength={noteMax}
          rows={3}
          className="w-full max-w-xl rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>
          To sign off, type <span className="font-mono">{phrase}</span>
        </span>
        <input
          name="confirmation"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="w-full max-w-md rounded border px-2 py-1 font-mono"
        />
      </label>
      <button
        type="submit"
        disabled={!all || typed !== phrase || pending}
        className="w-fit rounded border px-3 py-1 text-sm font-medium"
      >
        Record the sign-off
      </button>
      {state !== null && "error" in state && (
        <p role="alert" className="m-0 text-sm text-red-700">
          {errorText(state.error)}
        </p>
      )}
      {state !== null && "ok" in state && (
        <p role="status" className="m-0 text-sm">
          {state.changed
            ? "Sign-off recorded. Production full mode can now be switched on in System Health."
            : "This release is already signed off. Nothing changed."}
        </p>
      )}
    </form>
  );
}
