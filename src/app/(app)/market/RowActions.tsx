// The star and the "i" button of one company row (UXN-270). No server-only imports, so server pages and
// the search island can both use it.
import { OverviewSheet } from "./OverviewSheet";
import { StarButton, StarDisabled } from "./StarButton";
import type { WatchResult } from "./messages";

/** star = Owner or Editor with company names visible; disabled = Editor without them; none = Viewer (UX-004). */
export type WatchMode = "star" | "disabled" | "none";

export const DISABLED_STAR_REASON = "company names are hidden for your access level";

export function watchModeOf(role: string | null, masked: boolean): WatchMode {
  if (role !== "owner" && role !== "editor") return "none";
  return masked ? "disabled" : "star";
}

export function RowActions({
  slug,
  stock,
  starred,
  mode,
  starAction,
}: {
  /** Opaque slug for masked users, the code otherwise. */
  slug: string;
  /** Code, or "Stock A". */
  stock: string;
  starred: boolean;
  mode: WatchMode;
  starAction: (fd: FormData) => Promise<WatchResult>;
}) {
  return (
    <span className="inline-flex items-start gap-2">
      {mode === "star" ? (
        <StarButton code={stock} starred={starred} action={starAction} />
      ) : mode === "disabled" ? (
        <StarDisabled label={`Add ${stock} to watchlist`} reason={DISABLED_STAR_REASON} />
      ) : null}
      <OverviewSheet slug={slug} label={stock} />
    </span>
  );
}
