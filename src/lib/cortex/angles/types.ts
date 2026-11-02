// Angle registry types (M15 C1a; docs/M15_design.md 3a "angles"; CTX-011, CTX-030, D-292). An angle
// is a passport (metadata as code) plus, when it is computable from the as-of view, one pure
// `compute`. Score angles enter S through their cluster; gate and meta angles never do (CTX-011).
import type { AsOfView, InputKind } from "../pit/types";

export type { AsOfView, InputKind };

/** The six score clusters that carry weight (CTX-011). */
export type AngleCluster =
  "momentum" | "low_volatility" | "liquidity" | "event" | "quality" | "sentiment";
export const ANGLE_CLUSTERS: readonly AngleCluster[] = [
  "momentum",
  "low_volatility",
  "liquidity",
  "event",
  "quality",
  "sentiment",
];

/** Clusters of gate-only and meta angles: never in the score. */
export type GateCluster = "regime" | "risk" | "calendar" | "meta";
export const GATE_CLUSTERS: readonly GateCluster[] = ["regime", "risk", "calendar", "meta"];

export type AngleKind = "score" | "gate" | "meta";
export type AngleDomain = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type AngleFlag = string; // e.g. "at_high", "stale", "claimed"
/** undefined = not computable tonight (warming up / missing input / candidate). */
export type AngleValue =
  number | { readonly flag: AngleFlag } | { readonly bucket: string } | undefined;
export type AngleStatus = "candidate" | "measured" | "active" | "watch" | "retired";
export const ANGLE_STATUSES: readonly AngleStatus[] = [
  "candidate",
  "measured",
  "active",
  "watch",
  "retired",
];

export type GridPoint = Readonly<Record<string, number>>;

export type AngleDef = {
  readonly id: string; // "A-D1-01"
  readonly version: number;
  readonly domain: AngleDomain;
  readonly title: string;
  /** The passport definition in plain words (CTX-030 "definition"). */
  readonly definition: string;
  readonly kind: AngleKind; // gate/meta angles never enter S (CTX-011)
  readonly cluster: AngleCluster | GateCluster;
  readonly orientation: 1 | -1; // fixed before results (CTX-030)
  /** Own primary horizon in sessions (hold); 0 for a gate or meta angle without a forward horizon. */
  readonly horizonSessions: number;
  /** undefined before this many bars. */
  readonly warmupSessions: number;
  /** Every kind it reads; the registry refuses `active` unless each has a live reader. */
  readonly inputs: readonly InputKind[];
  /** Pre-registered grid points (CTX-034); each point is a charged cell (CTX-031). */
  readonly grid: Readonly<Record<string, readonly number[]>>;
  /** "announcement archive" | "fundamentals" | ... -> stays candidate (CTX-051, A-D10-09). */
  readonly needsData?: string;
  /** Passport history fields: what the offline history cannot show (revisions, vendor-only ratios, ...). */
  readonly historyFields?: readonly string[];
  /** D-292: rule ids and modules of the existing v1 implementation a gate/meta entry cites. */
  readonly existing?: readonly string[];
  /** Pure. Reads only through `view` at `t`. Absent for gate/meta entries that are existing rules. */
  readonly compute?: (view: AsOfView, code: string, t: number, grid: GridPoint) => AngleValue;
};
