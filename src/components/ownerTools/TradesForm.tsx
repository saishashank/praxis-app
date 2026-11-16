"use client";
// The trade-log entry (M21 B2, ARN-121, D-1221): one trade typed in, or a CSV with the same eight columns. Each save is a
// new row; a mistake is removed with a reason, never edited. No credential or broker field exists here (AT-78).
import { useActionState } from "react";
import type { OwnerActionResult } from "@/lib/ownerTools/result";

const FIELD = "min-h-9 min-w-0 rounded border px-2 py-1";
const LABEL = "flex min-w-0 flex-col gap-1 text-sm";

export function TradesForm({
  action,
  market,
}: {
  action: (fd: FormData) => Promise<OwnerActionResult>;
  market: string;
}) {
  const [state, run, pending] = useActionState<OwnerActionResult | null, FormData>(
    (_prev, fd) => action(fd),
    null,
  );
  return (
    <form action={run} className="flex flex-col gap-4" data-testid="trades-form">
      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Add a trade you made</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className={LABEL}>
            <span>Market</span>
            <input name="market" defaultValue={market} className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Company code</span>
            <input name="code" className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Bought or sold</span>
            <select name="side" defaultValue="buy" className={FIELD}>
              <option value="buy">Bought</option>
              <option value="sell">Sold</option>
            </select>
          </label>
          <label className={LABEL}>
            <span>Date (YYYY-MM-DD)</span>
            <input name="date" placeholder="2026-10-21" className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Shares</span>
            <input name="qty" inputMode="numeric" className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Price per share</span>
            <input name="price" inputMode="decimal" className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Fees (0 if none)</span>
            <input name="fees" inputMode="decimal" className={FIELD} />
          </label>
          <label className={LABEL}>
            <span>Note (optional)</span>
            <input name="note" maxLength={200} className={FIELD} />
          </label>
        </div>
        <div>
          <button
            type="submit"
            name="mode"
            value="typed"
            disabled={pending}
            className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {pending ? "Saving…" : "Add trade"}
          </button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Or import a CSV file</legend>
        <p className="m-0 text-xs text-text-muted">
          First row: <code>market,code,side,date,quantity,price,fees,note</code>. Up to 200 rows and
          64 KB. A file with any bad row adds nothing.
        </p>
        <input type="file" name="csv_file" accept=".csv,text/csv" className="text-sm" />
        <textarea
          name="csv_text"
          rows={4}
          aria-label="Or paste the CSV here"
          placeholder="market,code,side,date,quantity,price,fees,note"
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
