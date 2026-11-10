"use client";
// History status filter: the select submits its form on change when JavaScript runs. The Apply button is
// rendered on the server and stays usable without JavaScript; it is hidden once the page is interactive.
import { useSyncExternalStore } from "react";

const noop = () => () => {};

export function StatusFilter({
  current,
  options,
}: {
  current: string;
  options: readonly { value: string; label: string }[];
}) {
  const interactive = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return (
    <>
      <label htmlFor="history-status" className="font-medium">
        Show
      </label>
      <select
        id="history-status"
        name="status"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded-md border border-border bg-surface px-2 py-1"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        hidden={interactive}
        className="rounded-md border border-border bg-surface px-3 py-1 font-medium"
      >
        Apply
      </button>
    </>
  );
}
