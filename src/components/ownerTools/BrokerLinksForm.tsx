"use client";
// The Owner's broker address templates (M21 B1, UXN-317, D-1218): up to five rows of a name and an https address with
// {code} where the company code goes (and {market} for the market if wanted). Nothing ships pre-filled. No sign-in
// detail, key or token belongs in an address; the server refuses one, and it never calls the address itself.
import { useActionState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";
import type { BrokerLink } from "@/lib/preferences/brokerTemplate";

const ROWS = 5; // threshold-ok: at most five templates (D-1218)

export function BrokerLinksForm({
  action,
  current,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  current: readonly BrokerLink[];
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-3" data-testid="broker-form">
      <p className="m-0 text-sm text-text-muted">
        Add up to five links that open your own broker for a company. Copy the address your broker
        uses for a company page, start it with https, and write <code>{"{code}"}</code> where the
        company code goes. Never put a sign-in detail or a key in an address.
      </p>
      {Array.from({ length: ROWS }, (_, i) => (
        <div key={i} className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Name {i + 1}</span>
            <input
              type="text"
              name="broker_name"
              defaultValue={current[i]?.name ?? ""}
              maxLength={40}
              className="min-h-9 w-40 rounded border px-2 py-1"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Address {i + 1}</span>
            <input
              type="text"
              name="broker_template"
              defaultValue={current[i]?.url_template ?? ""}
              maxLength={300}
              className="min-h-9 w-full min-w-48 rounded border px-2 py-1"
            />
          </label>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save links"}
        </button>
        {state !== null && "ok" in state ? (
          <p role="status" className="m-0 text-sm">
            Saved.
          </p>
        ) : null}
        {state !== null && "error" in state ? (
          <p role="alert" className="m-0 text-sm text-red-700">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
