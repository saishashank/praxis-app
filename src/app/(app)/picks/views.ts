// The three views of the Picks page (D-1849): Today (default), History, Track record. State lives in the
// URL (`?profile=..&view=..`) so links stay shareable and server-rendered. Old links keep working: no
// `view`, `view=today` or an unknown value is Today; `view=history` and `view=track` are unchanged, and
// the old route /picks/track-record still renders the Track record body.
export const PICK_VIEWS = ["today", "history", "track"] as const;
export type PickView = (typeof PICK_VIEWS)[number];

export const PICK_VIEW_LABEL: Record<PickView, string> = {
  today: "Today",
  history: "History",
  track: "Track record",
};

/** The view a `view` search param names; anything else is Today. */
export function pickViewOf(raw: string | string[] | undefined): PickView {
  return raw === "history" || raw === "track" ? raw : "today";
}

/** Link of a view for a profile. Today has no `view` param (the original link). */
export function pickViewHref(view: PickView, profile: string): string {
  const p = `profile=${encodeURIComponent(profile)}`;
  return view === "today" ? `/picks?${p}` : `/picks?${p}&view=${view}`;
}
