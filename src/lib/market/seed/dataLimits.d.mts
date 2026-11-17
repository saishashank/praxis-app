export type SurvivorshipLimit = {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly until_own_snapshots: boolean;
  readonly matched_controls: "matched" | "unmatched";
  /** Matched controls exist only from this point (AU: `first_own_universe_snapshot`). */
  readonly matched_from?: string;
};
export type BlockedDataLimit = {
  readonly status: "BLOCKED-DATA";
  readonly ref: string;
  readonly text: string;
};
export type FundamentalsLimit = BlockedDataLimit & {
  readonly variant: string;
  readonly source_check?: {
    readonly rule: string;
    readonly checked_on: string;
    readonly result: "PASS" | "FAIL";
    readonly basis: string;
  };
};
export type DataLimits = {
  readonly survivorship: SurvivorshipLimit;
  readonly director_trades?: BlockedDataLimit;
  readonly fundamentals?: FundamentalsLimit;
};
export const DATA_LIMITS: Readonly<Record<string, DataLimits>>;
export function dataLimitsOf(code: string): DataLimits | undefined;
