// Result codes of the watchlist star and the plain text shown for each (UXN-047). No internals.
export type WatchError =
  "invalid" | "forbidden" | "masked" | "limit" | "unknown_code" | "unavailable";
export type WatchResult = { ok: true; starred: boolean; changed: boolean } | { error: WatchError };

export const WATCH_ERROR_TEXT: Record<WatchError, string> = {
  invalid: "That company could not be read. Reload the page and try again.",
  forbidden: "Your access level cannot keep a watchlist.",
  masked: "Company names are hidden for your access level, so a company cannot be starred.",
  limit: "The watchlist is full. Remove a company first.",
  unknown_code: "That company is not in the current list. Reload the page.",
  unavailable: "Something went wrong and nothing was changed. Please try again.",
};

export const watchErrorText = (code: string): string =>
  WATCH_ERROR_TEXT[code as WatchError] ?? WATCH_ERROR_TEXT.unavailable;
