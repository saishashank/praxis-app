// Plain types of the What-if page and its answer (UX-119). No server imports, so the client form may use them.

export type WhatIfOptions = {
  strategies: Array<{ id: string; name: string }>;
  profiles: string[];
  shocks: number[];
};

export type CostView = {
  kind: "cost";
  profile: string;
  ownProfile: string;
  liqNavMicro: number;
  ownLiqNavMicro: number;
  /** Chosen profile minus the strategy's own profile, micro (negative = the profile costs more). */
  diffMicro: number;
  feesMicro: number;
  ownFeesMicro: number;
};
export type ShockView = {
  kind: "shock";
  pct: number;
  pnlMicro: number;
  valueMicro: number;
  navAfterMicro: number;
};
export type WhatIfView = {
  execution: string;
  name: string;
  /** The night the stored rows are from. */
  d: string;
  result: CostView | ShockView;
};
