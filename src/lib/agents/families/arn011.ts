// ARN-011 manipulation / anomaly filters for U2/U3 entries (spec 05 l.41; design 4.3). Thresholds
// are Owner-only; they come in as data (ARN011_V1 by default). Only filters that need stored data
// are implemented (design 4.3). Pure and exact: gains and ranges are rational comparisons on the
// adjusted / raw micro series.
import { cmpRat, makeRational, mulRat, ratFromInt } from "@/lib/money/rational";
import type { EvalContext } from "./context";
import type { CodeFacts } from "./types";

export type Arn011Result = {
  /** Reasons the entry is blocked (empty = the filters pass). */
  readonly failed: readonly string[];
  /** Flags to show on the signal (e.g. "discount-unknown"). */
  readonly flags: readonly string[];
};

/** Gain over the last `sessions` closes (adjusted), exact; null when the history is too short. */
function gain(closes: readonly bigint[], sessions: number) {
  if (closes.length < sessions + 1) return null;
  const base = closes[closes.length - 1 - sessions]!;
  if (base <= 0n) return null;
  return makeRational(closes[closes.length - 1]! - base, base);
}

export function applyArn011(c: CodeFacts, ctx: EvalContext): Arn011Result {
  const t = ctx.arn011;
  const groups = ctx.groupsByCode.get(c.code) ?? [];
  const failed: string[] = [];
  const flags: string[] = [];

  if (c.halted) failed.push("halted");

  // +100% in 5 sessions without a price-sensitive announcement in those sessions
  const g5 = gain(c.closesAdj, t.gainSessions);
  if (g5 !== null && cmpRat(g5, t.gainMax) >= 0) {
    const item = groups.some(
      (g) => g.sessionsAgo < t.gainSessions && g.members.some((m) => m.priceSensitive),
    );
    if (!item) failed.push("gain_5s_without_price_sensitive_item");
  }

  // +30% in one session without a price-sensitive announcement that session
  const g1 = gain(c.closesAdj, 1);
  if (g1 !== null && cmpRat(g1, t.oneDayGain) >= 0) {
    const item = groups.some((g) => g.sessionsAgo < 1 && g.members.some((m) => m.priceSensitive));
    if (!item) failed.push("gain_1s_without_price_sensitive_item");
  }

  // volume ratio > 10 without an announcement on D
  const vr = c.ind.volumeRatio;
  if (vr !== null && cmpRat(vr, t.volumeRatioMax) > 0) {
    const item = groups.some((g) => g.sessionsAgo < 1);
    if (!item) failed.push("volume_spike_without_announcement");
  }

  // placements (capital raisings) in the window; any raise in the shorter window is a deep-discount
  // candidate whose issue price is unknown: it counts toward the placement rule and is flagged
  const raises = groups.filter((g) => g.members.some((m) => m.category === "capital_raising"));
  const placements = raises.filter((g) => g.sessionsAgo < t.placementWindow).length;
  if (placements >= t.placementsMax) failed.push("placements");
  if (raises.some((g) => g.sessionsAgo < t.raiseWindow)) flags.push("discount-unknown");

  if (c.promotional) failed.push("promotional");

  if (
    groups.some(
      (g) =>
        g.sessionsAgo < t.queryWindow && g.members.some((m) => m.category === "exchange_query"),
    )
  ) {
    failed.push("asx_query");
  }

  if (c.consolidationSessionsAgo !== null && c.consolidationSessionsAgo < t.consolidationWindow) {
    failed.push("consolidation");
  }

  // high-low range > 25% of price on at least 3 of the last 5 sessions
  const recent = c.rawBars.slice(-t.rangeDaysWindow);
  let wide = 0;
  for (const b of recent) {
    if (b.close <= 0n) continue;
    const range = ratFromInt(b.high - b.low);
    if (cmpRat(range, mulRat(t.rangeFraction, ratFromInt(b.close))) > 0) wide += 1;
  }
  if (wide >= t.rangeDaysMin) failed.push("wide_range");

  if (ctx.inputs.sources.asx === "off") flags.push("arn011-events-unavailable");

  return { failed, flags };
}
