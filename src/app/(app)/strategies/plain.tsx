// Plain-words helpers of the strategy pages (Owner 2026-11-10 usability pass, D-919): one date style,
// the cost profile as words, a market mood as one word and the ranking names as sentences. Pure.
import { cn } from "@/components/ui/cn";
import { COST_PROFILES } from "@/lib/arena/costs";
import { formatDay } from "@/lib/view/format";
import { regimeLabel } from "@/lib/view/terms";

/** "2026-11-03" -> "Tue 3 Nov"; text that is not an ISO day (an ISO week for a masked viewer) is kept. */
export function dayText(d: string | null | undefined): string {
  if (d === null || d === undefined) return "n/a";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? formatDay(d) : d;
}

/** "P5" -> "Default tiers (A$5 to A$29.95, then 0.12%)": what a trade costs, never the internal code. */
export function costProfileText(code: string | null | undefined): string {
  const p = code
    ? (COST_PROFILES as Record<string, { name: string } | undefined>)[code]
    : undefined;
  return p ? `brokerage ${p.name}` : "standard brokerage";
}

const RANKING: Record<string, string> = {
  v1: "Standard ranking",
  default: "Standard ranking",
  composite3: "Blend of momentum, calm and volume",
  vol_scaled: "Standard ranking scaled by how much the share swings",
};

/** "composite3" -> "Blend of momentum, calm and volume"; unknown names and "Ranking 2" are kept. */
export function rankingName(name: string): string {
  return name
    .split(",")
    .map((x) => x.trim())
    .map((x) => RANKING[x] ?? x)
    .join(", ");
}

const MOOD_MEANING: Record<string, string> = {
  "RISK-ON": "Prices are steady and trending up.",
  NEUTRAL: "No clear direction in the market.",
  "RISK-OFF": "Prices are swinging down.",
  SHOCK: "A sudden, sharp market fall.",
};

const MOOD_TONE: Record<string, string> = {
  SHOCK: "text-regime-shock",
  "RISK-OFF": "text-regime-riskoff",
  "RISK-ON": "text-regime-riskon",
  NEUTRAL: "text-regime-neutral",
};

/** The market mood as one plain word (the official regime code is not shown); the meaning is the hover text. */
export function MoodBadge({ regime }: { regime: string | null | undefined }) {
  const key = regime ?? "unknown";
  const f = regimeLabel(key);
  return (
    <span
      title={MOOD_MEANING[key] ?? f.hover}
      className={cn(
        "inline-flex max-w-full min-w-0 flex-col rounded-md bg-surface-2 px-2 py-1 text-xs leading-tight font-semibold break-words",
        MOOD_TONE[key] ?? "text-regime-neutral",
      )}
    >
      <span className="font-normal">Market mood</span>
      <span>{f.shown}</span>
    </span>
  );
}
