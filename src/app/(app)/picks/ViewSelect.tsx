"use client";
// View dropdown of the Picks page (D-1849): a native <select> with a visible label, named by the current
// view. It sits in a GET form, so it works without JavaScript (the Show button, hidden once the page is
// interactive) and the result is a plain, shareable, server-rendered URL. `view=today` is the default.
import { useSyncExternalStore } from "react";
import { PICK_VIEWS, PICK_VIEW_LABEL, type PickView } from "./views";

const noop = () => () => {};

export function ViewSelect({ current, profile }: { current: PickView; profile: string }) {
  const interactive = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return (
    <form method="get" action="/picks" className="flex items-center gap-2 text-sm">
      <input type="hidden" name="profile" value={profile} />
      <label htmlFor="picks-view" className="font-medium">
        View
      </label>
      <select
        id="picks-view"
        name="view"
        defaultValue={current}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-h-11 rounded-md border border-border bg-surface px-2 py-1"
      >
        {PICK_VIEWS.map((v) => (
          <option key={v} value={v}>
            {PICK_VIEW_LABEL[v]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        hidden={interactive}
        className="min-h-11 rounded-md border border-border bg-surface px-3 py-1 font-medium"
      >
        Show
      </button>
    </form>
  );
}
