export const ZONE_RULES: Readonly<Record<string, string>>;
export type FeedWindow = {
  readonly from: string;
  readonly until: string;
  readonly everyMin: number;
};
export type FeedPoint = { readonly at: string };
export type FeedSlots = {
  readonly poll: FeedWindow;
  readonly universe: FeedPoint;
  readonly fetch: FeedWindow;
  readonly late_sweep: FeedPoint;
  readonly marker_check: FeedPoint;
};
/** Keyed by market code; a market with no entry has no feed slot (M20 A2, D-1117). */
export const FEED_SLOT_TIMES: Readonly<Record<string, FeedSlots>>;
