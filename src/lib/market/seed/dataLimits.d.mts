export type SurvivorshipLimit = {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly until_own_snapshots: boolean;
  readonly matched_controls: "matched" | "unmatched";
};
export const DATA_LIMITS: Readonly<Record<string, { readonly survivorship: SurvivorshipLimit }>>;
export function dataLimitsOf(
  code: string,
): { readonly survivorship: SurvivorshipLimit } | undefined;
