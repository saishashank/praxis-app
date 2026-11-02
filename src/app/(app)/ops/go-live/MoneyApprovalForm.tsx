"use client";
// R2-S2: the Owner's approval of the money figures (cost profiles, tick table, slippage buckets,
// minimum parcel). The button stays disabled until the exact phrase is typed; the server action checks
// the phrase, the figure list and the Owner role again. Nothing here changes a figure or the mode.
import { useActionState, useState } from "react";
import { errorText } from "@/lib/users/messages";

type Result = { ok: true; changed: boolean } | { error: string };

type Props = {
  action: (fd: FormData) => Promise<Result>;
  ids: string[];
  phrase: string;
};

export function MoneyApprovalForm({ action, ids, phrase }: Props) {
  const [typed, setTyped] = useState("");
  const [state, run, pending] = useActionState<Result | null, FormData>(
    async (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="mt-3 flex flex-col gap-3">
      {ids.map((id) => (
        <input key={id} type="hidden" name="id" value={id} />
      ))}
      <label className="flex flex-col gap-1 text-sm">
        <span>
          I have checked these figures against the spec and my broker. To approve them, type{" "}
          <span className="font-mono">{phrase}</span>
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
        disabled={typed !== phrase || pending}
        className="w-fit rounded border px-3 py-1 text-sm font-medium"
      >
        Approve the money figures
      </button>
      {state !== null && "error" in state && (
        <p role="alert" className="m-0 text-sm text-red-700">
          {errorText(state.error)}
        </p>
      )}
      {state !== null && "ok" in state && (
        <p role="status" className="m-0 text-sm">
          {state.changed
            ? "Approval recorded. Production full mode is no longer held back by these figures."
            : "These figures are already approved. Nothing changed."}
        </p>
      )}
    </form>
  );
}
