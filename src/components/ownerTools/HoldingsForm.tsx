"use client";
// The holdings entry (M21 B1, UXN-316, D-1220): a table to type into, or a CSV with the columns code, quantity,
// average_cost. Each save is a new upload that replaces the current set. "Read from a screenshot" is not built: the
// control is disabled and says so (D-944).
import { useActionState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";
import { OCR_NOT_AVAILABLE_TEXT } from "@/lib/ownerTools/ocr";

const BLANK_ROWS = 5; // threshold-ok: empty rows offered under the saved ones
const FIELD = "min-h-9 min-w-0 rounded border px-2 py-1";

export type HoldingEntry = { code: string; qty: string; cost: string };

export function HoldingsForm({
  action,
  current,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  current: readonly HoldingEntry[];
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  const rows = [
    ...current,
    ...Array.from({ length: BLANK_ROWS }, () => ({ code: "", qty: "", cost: "" })),
  ];
  return (
    <form action={run} className="flex flex-col gap-4" data-testid="holdings-form">
      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Type your holdings</legend>
        <div className="grid grid-cols-3 gap-2 text-xs font-medium text-text-muted">
          <span>Company code</span>
          <span>Shares</span>
          <span>Average cost per share</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-3 gap-2">
            <input
              aria-label={`Company code ${i + 1}`}
              name="code"
              defaultValue={r.code}
              className={FIELD}
            />
            <input
              aria-label={`Shares ${i + 1}`}
              name="qty"
              inputMode="numeric"
              defaultValue={r.qty}
              className={FIELD}
            />
            <input
              aria-label={`Average cost ${i + 1}`}
              name="cost"
              inputMode="decimal"
              defaultValue={r.cost}
              className={FIELD}
            />
          </div>
        ))}
        <div>
          <button
            type="submit"
            name="mode"
            value="manual"
            disabled={pending}
            className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save holdings"}
          </button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Or import a CSV file</legend>
        <p className="m-0 text-xs text-text-muted">
          First row: <code>code,quantity,average_cost</code>. Up to 200 rows and 64 KB.
        </p>
        <input
          type="file"
          name="csv_file"
          accept=".csv,text/csv"
          aria-label="Choose a CSV file"
          className="text-sm"
        />
        <textarea
          name="csv_text"
          rows={4}
          aria-label="Or paste the CSV here"
          placeholder="code,quantity,average_cost"
          className="w-full rounded border px-2 py-1 font-mono text-sm"
        />
        <div>
          <button
            type="submit"
            name="mode"
            value="csv"
            disabled={pending}
            className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            Import CSV
          </button>
        </div>
      </fieldset>

      <div className="flex flex-col gap-1">
        <button
          type="button"
          disabled
          aria-describedby="ocr-note"
          className="w-fit rounded border px-4 py-2 text-sm font-medium opacity-60"
        >
          Read from a screenshot
        </button>
        <p id="ocr-note" data-testid="ocr-note" className="m-0 text-xs text-text-muted">
          {OCR_NOT_AVAILABLE_TEXT}
        </p>
      </div>

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
    </form>
  );
}
