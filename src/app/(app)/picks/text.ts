// Plain-words helpers of the Picks pages (UXN-040..045, ARN-095). Pure: no database, no clock.
// Every figure comes from a stored, published value; nothing here computes a price or a probability.
import type { PickRowView, TrackRow } from "@/lib/ui/loaders/picks";
import { formatPpm } from "@/lib/view/format";

export const HONESTY_BASE = "Personal use only · Not financial advice";
export const HONESTY_NOT_PROVEN = "Model not proven yet";
export const STOP_GAP_HOVER =
  "Prices can gap past a stop-loss (open far below it), so the loss can be bigger than shown.";
export const SELECTION_LINE = "Picks are chosen by strength of evidence, then signal score.";
export const PRICE_ONLY_LABEL = "Price only — dividends not included.";
export const NOT_REAL_ORDERS = "Simulated tracking only. Nothing here places an order.";

/** UXN-045: the last part is shown only until the live record beats the luck check. */
export const honestyLine = (beatsLuck: boolean): string =>
  beatsLuck ? HONESTY_BASE : `${HONESTY_BASE} · ${HONESTY_NOT_PROVEN}`;

export const profileLabel = (name: string): string =>
  name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, " ");

type ProfileRules = { tiers: string[]; maxPct: number; riskPct: number };

/** pick_profiles (config) -> one validated entry, or null when the shape is not as expected. */
export function profileRules(cfg: unknown, name: string): ProfileRules | null {
  if (typeof cfg !== "object" || cfg === null) return null;
  const p = (cfg as Record<string, unknown>)[name];
  if (typeof p !== "object" || p === null) return null;
  const o = p as Record<string, unknown>;
  const tiers = Array.isArray(o.tiers)
    ? o.tiers.filter((t): t is string => typeof t === "string")
    : [];
  if (typeof o.max_pct_per_pick !== "number" || typeof o.risk_pct_per_pick !== "number")
    return null;
  return { tiers, maxPct: o.max_pct_per_pick, riskPct: o.risk_pct_per_pick };
}

const TIER_WORDS: Record<string, string> = { U1: "large", U2: "mid-size", U3: "small" };

/** The one-sentence rule of a profile (UXN-040 hover), from the stored caps. */
export function profileSentence(rules: ProfileRules | null): string {
  if (rules === null) return "Rules for this profile are not available.";
  // D-200: "large and mid-size companies", not "largest, mid-size companies"
  const words = rules.tiers.map((t) => TIER_WORDS[t] ?? t);
  const sizes =
    words.length > 1
      ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
      : words.join("");
  return `Picks from ${sizes} companies. No more than ${rules.maxPct}% of the portfolio goes into one company, and no more than ${rules.riskPct}% of it is at risk on one pick.`;
}

/** At most `max` picks per family, in the loader's order (rank). */
export function capPerFamily<T extends { family: string }>(picks: readonly T[], max: number): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const p of picks) {
    const n = seen.get(p.family) ?? 0;
    if (n >= max) continue;
    seen.set(p.family, n + 1);
    out.push(p);
  }
  return out;
}

export const SESSIONS_PER_WEEK = 5; // threshold-ok: trading days in a week

/** "about 3 weeks" from a count of sessions. */
export function timeFrameText(sessions: number | null): string | null {
  if (sessions === null) return null;
  if (sessions < SESSIONS_PER_WEEK)
    return sessions === 1 ? "about 1 day" : `about ${sessions} days`;
  const weeks = Math.round(sessions / SESSIONS_PER_WEEK);
  return weeks === 1 ? "about 1 week" : `about ${weeks} weeks`;
}

export const pct = (ppm: number | null, sign: "always" | "minus" = "always"): string =>
  formatPpm(ppm, { digits: 0, sign });

const EXIT_WORDS: Record<string, string> = {
  stop: "stop-loss hit",
  gap: "price gapped past the stop-loss",
  aim: "aim reached",
  time_frame: "time frame ended",
};
export const exitWords = (r: string | null): string | null =>
  r === null ? null : (EXIT_WORDS[r] ?? r);

export const POSITION_WORDS = {
  inside: "inside the expected range",
  below: "below the expected range",
  above: "above the expected range",
} as const;

/** D-187: why a nightly check withdrew a waiting pick, in plain words. */
export const WITHDRAWN_WORDS: Record<string, string> = {
  data: "a data problem or a trading halt",
  below_stop: "the price fell to the stop-loss",
  aim_reached: "the price reached the aim before it could be bought",
  negative_news: "negative company news",
  regime: "the market turned against this strategy",
  evidence: "the strategy's track record failed",
  edge_eroded: "the price moved up and too little gain was left for the risk",
  horizon: "it waited longer than similar trades usually last",
};

export function stateText(
  o: PickRowView["outcome"] | { state: string; withdrawnReason?: string | null } | null,
): string {
  switch (o?.state) {
    case "waiting":
      return "Waiting to buy";
    case "bought":
      return "Bought";
    case "missed": {
      const r = o && "withdrawnReason" in o ? (o.withdrawnReason ?? null) : null;
      return r === null ? "Withdrawn" : `Withdrawn — ${WITHDRAWN_WORDS[r] ?? r}`;
    }
    case "closed":
      return "Closed";
    default:
      return "Not tracked yet";
  }
}

export const trackStateText = (r: TrackRow): string => stateText(r);

/** UXN-311: the one badge table lives in src/lib/ui/familyBadge.ts (D-393). */
export { FAMILY_BADGE as FAMILY_BADGES } from "@/lib/ui/familyBadge";

/** UXR-007: one sentence on what will appear and when. */
export const EMPTY_PICKS_SENTENCE =
  "Picks for this profile appear here after tonight's run (about 6:30 pm) finds enough evidence.";
export const EMPTY_TRACK_SENTENCE =
  "Picks appear here after they are published and followed on paper.";

// ---- M17 WP8 wording (UXN-301..311, NFR-041). Plain words; never "real-time"; every intraday figure is delayed. ----

export const TONIGHT_TITLE = "Tonight's picks";
export const INTRADAY_TITLE = "Intraday watch";
export const INTRADAY_EXPLAINER =
  "Stocks with news today that have already moved. Found during the day from delayed prices, not rated, not checked against past results.";
export const INTRADAY_UNRATED = "Unrated - no history yet";
export const INTRADAY_UNVALIDATED =
  "Unvalidated: this stream has not been tested against past results.";
export const NO_HISTORY = "Not enough history yet";

/** NFR-041: the delay statement in help text. */
export const delayStatement = (delayMin: number): string =>
  `Prices here are delayed: up to about ${delayMin} minutes after the trade, plus the time between refreshes. Each one shows the time of its quote.`;
export const ALERT_DELAY_HELP =
  "Alert prices come from a delayed feed: up to about 20 minutes after the trade, plus the time between refreshes. A hit means the delayed price reached your buy limit; the time shown is the quote time.";

export const ALERT_SETTING_WORDS = {
  pickAlerts: "Buy-price alerts",
  cleared: "E-mail when a pick's alert is cleared",
  candidates: "E-mail for new intraday candidates",
  cap: "Most alert e-mails a day",
  quiet:
    "Alerts that arrive in this window are held and sent as one digest afterwards. Nothing here is urgent (P0); those always arrive.",
} as const;

export const CLEAR_WORDS: Record<string, string> = {
  left_list: "Left the list",
  below_stop: "Price fell below the stop-loss",
  above_chase_cap: "Price moved too far above the buy limit",
  halted: "Trading halted",
  expired: "Expired",
  muted: "Muted by you",
  filled: "Bought in the practice portfolio",
};

export const MAIL_WORDS: Record<string, string> = {
  sent: "E-mail sent",
  batched: "Sent with others",
  suppressed: "E-mail held back (daily limit)",
  held: "Held until quiet hours end",
  off: "E-mail off",
  none: "No e-mail",
};

export const SORT_WORDS = {
  chance: "Sorted by chance of a net gain",
  expected_gain: "Sorted by typical past result",
  toChance: "Sort by chance",
  toGain: "Sort by expected gain",
} as const;

// ARN-103/104, UXN-288, D-490/D-491: picks against the market.
/** Percentage points with one decimal and a sign, from ppm (1 pp = 10 000 ppm). */
export function ppText(ppm: number | null): string {
  if (ppm === null) return "not measured";
  const tenths = Math.round((Math.abs(ppm) / 10_000) * 10) / 10; // threshold-ok: ppm to pp
  return `${ppm < 0 ? "-" : "+"}${tenths.toFixed(1)} pp`;
}
export const VS_MARKET_CAPTION = "Past paper picks, not a forecast.";
export const VS_MARKET_INSUFFICIENT = "insufficient history";
export const VS_MARKET_HELP =
  "Market = S&P/ASX 200. The index has closes only, so each window runs from the close before the pick was bought to the close of the day it was sold. Vs market = the pick's result after costs minus the market's.";
export const MISSED_NOT_BOUGHT = "missed, not bought";
export const vsMarketRowText = (v: NonNullable<TrackRow["vsMarket"]>): string =>
  v.missed
    ? `market ${ppText(v.marketRetPpm)} over the window; ${MISSED_NOT_BOUGHT}`
    : `vs market ${ppText(v.vsPpm)} (market ${ppText(v.marketRetPpm)})`;
export function vsMarketSummaryLine(s: {
  n: number;
  medianPpm: number | null;
  beatingPct: number | null;
  insufficient: boolean;
}): string {
  if (s.insufficient) return `Vs market: ${VS_MARKET_INSUFFICIENT} (n = ${s.n}).`;
  return `Median vs market ${ppText(s.medianPpm)}; ${s.beatingPct}% of picks beat the market; n = ${s.n}.`;
}
