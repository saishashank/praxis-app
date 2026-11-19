import type { MarketModeValue, ProfileField, WorkStatus } from "./fields.mjs";

export const HOME_MARKET: string;
export const OWNER_TZ: string;
export const GLOBAL_INDICES: readonly string[];
export type OpsSlotTime =
  | { readonly at: string }
  | { readonly from: string; readonly until: string; readonly everyMin: number };
export const OPS_SLOT_TIMES: Readonly<Record<string, OpsSlotTime>>;

export type CurrencyFormat = {
  readonly code: string;
  readonly symbol: string;
  readonly locale: string;
};
export const CURRENCY_FORMATS: Readonly<Record<string, CurrencyFormat>>;
export function currencyFormatOf(currency: string): CurrencyFormat;
export function marketsEnabledDefault(
  env?: Record<string, string | undefined>,
  built?: readonly string[],
): string[];

export function encodeValue(value: unknown): string;
export function decodeValue(text: string): unknown;
export function addMinutes(hhmm: string, minutes: number): string;
/** A `mkt.<CODE>.<field>` key value as the field value it stands for; undefined when it does not apply. */
export function valueFromKey(field: string, raw: unknown, current: unknown): unknown;
/** A field value as its `mkt.<CODE>.<field>` key stores it (parcel_floor in whole currency units, etc.). */
export function overlayKeyValue(field: string, value: unknown): unknown;

export type FieldRecord = {
  readonly value: unknown;
  /** 1 = a [VERIFY] value awaiting evidence. */
  readonly verify: 0 | 1;
  readonly verifiedAt: string | null;
  readonly evidenceRef: string | null;
  /** True when the value comes from a `mkt.<CODE>.<field>` key rather than the stored row. */
  readonly overlay: boolean;
};

export type Completeness = {
  readonly total: number;
  readonly valued: number;
  readonly verified: number;
  readonly missing: readonly string[];
  readonly unverified: readonly string[];
  readonly complete: boolean;
};

export type SlotAnchors = {
  readonly b1: string;
  readonly b2a: string;
  readonly b2b: string;
  readonly late_2a_after: string;
  readonly cutoff: string;
  readonly cutoff_poll: string;
  readonly preopen_recheck: readonly [string, string];
  readonly quote_from: string;
  readonly quote_until: string;
  readonly intraday_scan_from: string;
  readonly intraday_scan_until: string;
};

export type TickBand = { readonly fromMicro: bigint; readonly tickMicro: bigint };
export type IndexSpec = { readonly code: string; readonly yahoo: string; readonly name?: string };
export type OpeningAuctionWindow =
  | { readonly kind: "staggered"; readonly from: string; readonly to: string }
  | {
      readonly kind: "single";
      readonly at: string;
      readonly call_auction?: { readonly from: string; readonly to: string };
    };
export type BatchSchedule =
  | {
      readonly kind: "fixed";
      readonly zone: string;
      readonly b1: string;
      readonly b2a: string;
      readonly b2b: string;
      readonly late_2a_after: string;
    }
  | {
      readonly kind: "after_close";
      readonly b1: number;
      readonly b2a: number;
      readonly b2b: number;
      readonly late_2a_after: number;
    };
export type KnownTimeRules = {
  readonly filings: string;
  readonly bars: string;
  readonly index_global: {
    readonly local?: string;
    readonly zone?: string;
    readonly lag_days?: number;
    readonly kind?: string;
  };
};
export type SlippageSpec = {
  readonly buckets: readonly { readonly fromAdvMicro: bigint; readonly bps: number }[];
  readonly tick_cross_factor: number;
  readonly stall_floor_bps: number;
  readonly untradeable_adv_fraction: { readonly num: number; readonly den: number };
  readonly half_spread_ppm_by_tier: Readonly<Record<"U1" | "U2" | "U3", bigint>>;
};
export type TierRules = Readonly<Record<string, unknown>>;
export type BarLatency = number | { readonly kind: "at_cutoff" } | null;

export type MarketProfile = {
  readonly code: string;
  readonly name: string;
  readonly workStatus: WorkStatus;
  readonly statusChangedAt: string | null;
  readonly builtAt: string | null;
  readonly evidenceRecordedAt: string | null;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly enabled: boolean;
  readonly mode: MarketModeValue;
  readonly fields: Readonly<Partial<Record<ProfileField, FieldRecord>>>;
  readonly exchange: string | null;
  readonly tz: string | null;
  readonly sessionOpen: string | null;
  readonly sessionClose: string | null;
  readonly currency: string | null;
  /** The decision cut-off time (HH:MM) and the zone it is written in. */
  readonly decisionCutoff: string | null;
  readonly decisionCutoffZone: string | null;
  readonly settlementDays: number | null;
  readonly parcelFloorMicro: bigint | null;
  readonly advFloorPerParcelMicro: bigint | null;
  readonly openingAuctionWindow: OpeningAuctionWindow | null;
  readonly preopenRecheckMin: number | null;
  readonly preopenAt: string | null;
  readonly costFormula: string | null;
  readonly classificationScheme: string | null;
  readonly haltModel: string | null;
  readonly benchmarkIndex: string | null;
  readonly benchmarkYahooSymbol: string | null;
  readonly regimeIndex: string | null;
  readonly volatilityIndex: string | null;
  readonly indexCodes: readonly string[];
  readonly yahooSuffix: string | null;
  readonly dividendImputation: boolean | null;
  readonly angleCount: number;
  readonly universeMax: number | null;
  readonly tickTable: readonly TickBand[] | null;
  readonly tiers: TierRules | null;
  readonly slippage: SlippageSpec | null;
  readonly batchSchedule: BatchSchedule | null;
  readonly knownTimeRules: KnownTimeRules | null;
  readonly barLatencyP95Min: BarLatency;
  readonly currencyFormat: CurrencyFormat | null;
  /** The Worker's slot anchors (null until open, close, cut-off and batch schedule are set). */
  readonly slots: SlotAnchors | null;
  readonly completeness: Completeness;
  readonly complete: boolean;
};

export type MarketRowInput = {
  code: string;
  tz: string;
  open_time: string;
  close_time: string;
  cutoff_time: string;
  currency: string;
  mode: string;
  enabled: number;
  slots_json?: string | null;
};
export type ProfileRowInput = {
  code: string;
  work_status: string;
  status_changed_at: string | null;
  built_at: string | null;
  evidence_recorded_at: string | null;
  profile_version: number;
  updated_at: string | null;
};
export type FieldRowInput = {
  field: string;
  value_json: string;
  verify: number;
  verified_at: string | null;
  evidence_ref: string | null;
};

export function profileFromRows(rows: {
  market: MarketRowInput;
  profile: ProfileRowInput;
  fieldRows: readonly FieldRowInput[];
  overlay?: Readonly<Record<string, unknown>>;
  name?: string;
}): MarketProfile;

export function completeness(profile: {
  fields: Readonly<
    Partial<
      Record<ProfileField, Pick<FieldRecord, "value" | "verify" | "verifiedAt" | "evidenceRef">>
    >
  >;
}): Completeness;
export function isComplete(profile: {
  fields: Readonly<
    Partial<
      Record<ProfileField, Pick<FieldRecord, "value" | "verify" | "verifiedAt" | "evidenceRef">>
    >
  >;
}): boolean;
export function slotsProjection(profile: {
  sessionOpen: string | null;
  sessionClose: string | null;
  decisionCutoff: string | null;
  batchSchedule: unknown;
  preopenRecheckMin: number | null;
}): SlotAnchors | null;
export function slotsJson(profile: Parameters<typeof slotsProjection>[0]): string | null;
