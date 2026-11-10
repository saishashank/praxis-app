// Fixed texts and small formatters of the Market pages (UXN-270..273). Plain words, no internals.
import { formatMicro, formatPpm } from "@/lib/view/format";
import type { MaRelation } from "@/lib/ui/loaders/company";

export const PRICE_LABEL = "End of day";
export const PRICE_NOTE =
  "Prices show the last close, or a delayed quote (up to about 20 minutes late) where we have one. Nothing here places an order.";
export const NOT_AVAILABLE = "Not available";
export const MASKED_MARKET_NOTE =
  "Company names, codes and prices are hidden for your access level. You see how each stock moved, as Stock A, Stock B and so on.";

const PPM = 1_000_000; // threshold-ok: parts per million
const HUNDRED = 100; // threshold-ok: percent

/** 1,200,000 ppm -> "1.20× usual"; null -> "n/a". */
export function volumeVsUsual(ppm: number | null): string {
  if (ppm === null || !Number.isFinite(ppm)) return "n/a";
  return `${(ppm / PPM).toFixed(2)}× usual`;
}

/** "Above its 50-day average (+3.20%)" or "Not enough history". */
export function maText(ma: MaRelation): string {
  if (ma === null) return "Not enough history yet";
  return `${ma.above ? "Above" : "Below"} its ${ma.days}-day average (${formatPpm(ma.gapPpm, { sign: "always" })})`;
}

/** 0..1,000,000 -> "Price is 62% of the way from its 52-week low to its high". */
export function rangePositionText(ppm: number | null): string {
  if (ppm === null) return "n/a";
  return `Price is ${Math.round((ppm / PPM) * HUNDRED)}% of the way from its 52-week low to its high`;
}

/** Index level in micro points -> "8,679.70" (index points: never "A$", never the raw micro number). */
export function formatIndexPoints(micro: number | string | bigint): string {
  return formatMicro(micro).replace("A$", "");
}

/** Average sector move in ppm -> percent for the heat grid. */
export const ppmToPercent = (ppm: number): number => ppm / (PPM / HUNDRED);
