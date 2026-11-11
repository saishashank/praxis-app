// M17 WP5: the candidate rule (AGT-141), pure. Catalyst AND move AND volume AND fresh quote.
// A move without a catalyst is not a candidate. Unknown volume fails the volume condition (D-382).
// D-1040..D-1043 (Owner O-83, "Buy ideas only"): a CANDIDATE is a buy idea: good news, the price up,
// and still early in the rise. Bad news with the price down passes the same tests but is an "avoid"
// row (shown as "Avoid / watch"); anything else (mixed news, news against the price) is dropped.
import type { Catalyst } from "@/lib/sentinel/todayItems";
import { ideaSide, type IdeaSide } from "./side";

export const SD_MULT_PPM = 1_500_000; // threshold-ok: AGT-141 "1.5 x 60-session sd"
/**
 * D-1042: "still early in its rise": a buy idea is up by no more than this many times the smallest
 * move that qualifies (`moveThresholdPpm`: 4 % or 1.5 x the 60-session sd, whichever is larger), so
 * 4 % to 8 % on a quiet stock. A stock that has already run further has made most of its move.
 */
export const EARLY_MAX_MULT = 2; // threshold-ok: D-1042 early window = 1 to 2 x the qualifying move
const PPM = 1_000_000; // threshold-ok: unit
const PCT_TO_PPM = 10_000; // threshold-ok: unit (1 % = 10,000 ppm)

export type CandidateParams = {
  /** `intraday_move_min_pct`. */
  moveMinPct: number;
  /** `intraday_rel_volume_min`. */
  relVolumeMin: number;
  /** Oldest quote still fresh, minutes (feed delay + 2 x refresh, D-441). */
  maxAgeMin: number;
};

export type CandidateInput = {
  catalyst: Catalyst | null;
  movePpm: number;
  /** Sector-adjusted move; null when no sector series is available (the raw move is used). */
  sectorAdjPpm: number | null;
  /** Standard deviation of 60 daily returns, ppm. */
  sd60Ppm: number | null;
  /** Cumulative volume over the pro-rated 20-session average, ppm; null = unavailable. */
  relVolumePpm: number | null;
  quoteAgeMin: number;
  params: CandidateParams;
};

export type CandidateCondition = "catalyst" | "move" | "volume" | "fresh" | "direction" | "early";
export type CandidateVerdict =
  { ok: true; side: IdeaSide } | { ok: false; failed: CandidateCondition[] };

/** D-1042: the largest rise that still counts as early, in ppm. */
export function earlyMaxPpm(sd60Ppm: number | null, moveMinPct: number): number {
  return moveThresholdPpm(sd60Ppm, moveMinPct) * EARLY_MAX_MULT;
}

/** Smallest absolute move that counts: max(`intraday_move_min_pct`, 1.5 x sd), in ppm. */
export function moveThresholdPpm(sd60Ppm: number | null, moveMinPct: number): number {
  const floor = Math.round(moveMinPct * PCT_TO_PPM);
  if (sd60Ppm === null) return floor;
  return Math.max(floor, Math.round((sd60Ppm * SD_MULT_PPM) / PPM));
}

export function isCandidate(x: CandidateInput): CandidateVerdict {
  const failed: CandidateCondition[] = [];
  if (x.catalyst === null || x.catalyst.materiality < 2) failed.push("catalyst"); // threshold-ok: AGT-141a
  const effective = x.sectorAdjPpm ?? x.movePpm;
  if (Math.abs(effective) < moveThresholdPpm(x.sd60Ppm, x.params.moveMinPct)) failed.push("move");
  if (x.relVolumePpm === null || x.relVolumePpm < Math.round(x.params.relVolumeMin * PPM)) {
    failed.push("volume");
  }
  if (!(x.quoteAgeMin <= x.params.maxAgeMin)) failed.push("fresh");
  // D-1040: good news with the price up (buy) or bad news with the price down (avoid); the raw move and
  // the sector-adjusted move must both point that way. Mixed news is neither. Judged once the catalyst
  // and the size of the move are in order, so a failure names the first thing that is wrong.
  let side: IdeaSide | null = null;
  if (!failed.includes("catalyst") && !failed.includes("move")) {
    const pol = x.catalyst?.polarity ?? 0;
    const polarity = pol > 0 ? "positive" : pol < 0 ? "negative" : "neutral";
    side = ideaSide(polarity, x.movePpm);
    if (side === null || side !== ideaSide(polarity, effective)) failed.push("direction");
    // D-1042: a buy idea must still be early in its rise
    else if (side === "buy" && x.movePpm > earlyMaxPpm(x.sd60Ppm, x.params.moveMinPct)) {
      failed.push("early");
    }
  }
  if (failed.length > 0 || side === null) return { ok: false, failed };
  return { ok: true, side };
}
