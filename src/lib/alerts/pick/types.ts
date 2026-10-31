// M17 WP3: types of the pick alert state machine (ARN-110..115; docs/M17_design.md "Interfaces").
// No I/O, no Cortex, no order or book type: an alert knows a limit, a stop and a quote, nothing else.
import type { DelayedQuote } from "@/lib/data/quotes/types";
import type { Exec } from "@/lib/cortex/store/common";

export const CLEAR_REASONS = [
  "left_list",
  "below_stop",
  "above_chase_cap",
  "halted",
  "expired",
  "muted",
  "filled", // D-394: in-app only, no e-mail
] as const;
export type ClearReason = (typeof CLEAR_REASONS)[number];

/** ARN-114: only these two clears send one information e-mail; the rest are in-app only. */
export const MAILED_CLEAR_REASONS: readonly ClearReason[] = ["below_stop", "above_chase_cap"];

export type AlertStateName = "armed" | "hit" | "cleared";

/** The state of one alert as the pure evaluator sees it (the latest `pick_alert` row plus counts). */
export type AlertState = {
  state: AlertStateName;
  limitMicro: bigint;
  stopMicro: bigint;
  armedSession: string;
  /** Sessions from the arming session to the evaluated session, both included. */
  sessionsArmed: number;
  /** A `hit` row exists for the evaluated session: no second hit, no price clear (ARN-113). */
  hitThisSession: boolean;
};

export type AlertParams = {
  /** `chase_cap_pct`. */
  chaseCapPct: number;
  /** `pick_alert_max_sessions`. */
  maxSessions: number;
  /** 2 x `intraday_refresh_min`. */
  maxAgeMin: number;
  /** `intraday_quote_delay_min`. */
  delayMin: number;
};

export type EvalCtx = {
  session: string;
  now: Date;
  halted: boolean;
  /** The pick is still on the current list and unwithdrawn (`armableOrders`). */
  inList: boolean;
  /** The simulated book bought it (`pick_outcome`). */
  filled: boolean;
  muted: boolean;
  params: AlertParams;
};

export type Transition =
  | { state: "hit"; hitMicro: bigint; quoteAt: string }
  | { state: "cleared"; reason: ClearReason; quoteAt?: string };

/** One pick the alert stream may arm (V1 now; the allowed-family Cortex branch returns none). */
export type ArmableOrder = {
  pickKey: { market: string; d: string; profile: string; rank: number };
  code: string;
  limitMicro: bigint;
  stopMicro: bigint;
  family: string;
  publishedAt: string;
};

/** A stored transition row. */
export type AlertRow = {
  alertId: string;
  seq: number;
  userId: string;
  market: string;
  pickD: string;
  profile: string;
  rank: number;
  code: string;
  sessionD: string;
  state: AlertStateName;
  limitMicro: bigint;
  stopMicro: bigint;
  at: string;
  hitMicro: bigint | null;
  quoteAt: string | null;
  clearReason: ClearReason | null;
};

/** A transition that was just written and may be e-mailed (hit; below_stop; above_chase_cap). */
export type MailableTransition = AlertRow;

export type MailerCtx = { db: Exec; now: Date; market: string; sessionD: string };

/**
 * Hook for WP4 (`sendPickMail`): called after the state rows are written, never before (state first,
 * mail second). The default does nothing, so no mail leaves until WP4 plugs in.
 */
export type PickAlertMailer = {
  /** One tick's mailable transitions (batched by the implementation). */
  notify: (ctx: MailerCtx, transitions: readonly MailableTransition[]) => Promise<void>;
  /** Step 3 of the tick: the held-mail digest after quiet hours. */
  digest: (ctx: MailerCtx) => Promise<void>;
};

export const NO_MAILER: PickAlertMailer = {
  notify: async () => {},
  digest: async () => {},
};

export type QuoteByCode = ReadonlyMap<string, DelayedQuote>;
