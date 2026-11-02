// M17 WP5: the candidate rule (AGT-141), pure. Catalyst AND move AND volume AND fresh quote.
// A move without a catalyst is not a candidate. Unknown volume fails the volume condition (D-382).
import type { Catalyst } from "@/lib/sentinel/todayItems";

export const SD_MULT_PPM = 1_500_000; // threshold-ok: AGT-141 "1.5 x 60-session sd"
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

export type CandidateCondition = "catalyst" | "move" | "volume" | "fresh";
export type CandidateVerdict =
  { ok: true; polarityConsistent: boolean } | { ok: false; failed: CandidateCondition[] };

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
  if (failed.length > 0) return { ok: false, failed };
  const pol = x.catalyst?.polarity ?? 0;
  return { ok: true, polarityConsistent: pol === 0 || Math.sign(effective) === pol };
}
