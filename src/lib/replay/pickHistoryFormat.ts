// D-908: the stored format of a full replay's development track record per group (written by
// ./pickHistory.ts, read by src/lib/picks/inputs.ts). Kept apart so the picks bundle imports no
// replay code.
export const PICK_HISTORY_SCOPE = "pick_history:";
export const PICK_HISTORY_METRIC = "dev_summary";
export const PICK_HISTORY_FORMAT = 1;

export type PickHistorySummary = {
  readonly v: typeof PICK_HISTORY_FORMAT;
  readonly lineage: string;
  readonly split: {
    readonly version: number;
    readonly dev_end_d: string | null;
    readonly deferred_until_d: string | null;
    readonly data_end_d: string;
    /** True when the split is the lineage's stored one, false when computed in the run. */
    readonly stored: boolean;
  };
  readonly n: number;
  readonly insufficient: boolean;
  readonly reason: string | null;
  readonly p10_ppm: number | null;
  readonly p50_ppm: number | null;
  readonly p90_ppm: number | null;
  /** Lower median of the holding sessions, entry and exit sessions included (as the picks loader). */
  readonly hold_median: number | null;
  /** Lower median of |MAE| in ppm over the development rows with bars. */
  readonly median_drop_ppm: number | null;
  /** Share (ppm) of development rows whose net return reached the good case (p90). */
  readonly aim_reach_ppm: number | null;
  /** Share (ppm) of development rows that ended with a net gain (net > 0); null without rows. */
  readonly win_rate_ppm?: number | null;
};
