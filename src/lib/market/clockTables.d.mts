export const ZONE_RULES: Readonly<Record<string, string>>;
export type FeedWindow = {
  readonly from: string;
  readonly until: string;
  readonly everyMin: number;
};
export type FeedPoint = { readonly at: string };
export const FEED_SLOT_TIMES: {
  readonly poll: FeedWindow;
  readonly universe: FeedPoint;
  readonly fetch: FeedWindow;
  readonly late_sweep: FeedPoint;
  readonly marker_check: FeedPoint;
};
