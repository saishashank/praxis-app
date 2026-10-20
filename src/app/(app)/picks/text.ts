// Plain-words helpers of the Picks pages (UXN-040..045, ARN-095). Pure: no database, no clock.
// Every figure comes from a stored, published value; nothing here computes a price or a probability.
import type { PickRowView, TrackRow } from "@/lib/ui/loaders/picks";
import { formatPpm } from "@/lib/view/format";

export const HONESTY_BASE = "Personal use only · Not financial advice";
export const HONESTY_NOT_PROVEN = "Model not proven yet";
export const STOP_GAP_HOVER =
  "Prices can gap past a stop-loss (open far below it), so the loss can be bigger than shown.";
export const SELECTION_LINE = "Picks are chosen by strength of evidence, then signal score.";
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

const TIER_WORDS: Record<string, string> = { U1: "largest", U2: "mid-size", U3: "smaller" };

/** The one-sentence rule of a profile (UXN-040 hover), from the stored caps. */
export function profileSentence(rules: ProfileRules | null): string {
  if (rules === null) return "Rules for this profile are not available.";
  const sizes = rules.tiers.map((t) => TIER_WORDS[t] ?? t).join(", ");
  return `Picks from ${sizes} companies; no more than ${rules.maxPct}% of the portfolio in one company and no more than ${rules.riskPct}% at risk.`;
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

export function stateText(o: PickRowView["outcome"] | { state: string } | null): string {
  switch (o?.state) {
    case "waiting":
      return "Waiting to buy";
    case "bought":
      return "Bought";
    case "missed":
      return "Missed — price ran away";
    case "closed":
      return "Closed";
    default:
      return "Not tracked yet";
  }
}

export const trackStateText = (r: TrackRow): string => stateText(r);
