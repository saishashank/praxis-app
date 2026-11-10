// D-921: the improvement list of the daily learning loop (pure; at most 6 items, most important first).
// Each item states its evidence in numbers and one action in plain words. Nothing here changes a rule:
// the actions are proposals for the Owner and for the existing learning pipeline.
import { formatDay } from "@/lib/view/format";
import type { DailyLearning, FeatureLesson, ImprovementItem, MoverCause } from "./daily";
import { PPM, pct } from "./dailyMovers";

export const MAX_IMPROVEMENTS = 6; // threshold-ok: D-921 at most 6 items
/** Sessions looked at for blocked signals, empty nights and uncaught movers. */
export const LOOKBACK = 10; // threshold-ok: D-921 last 10 sessions
const MIN_BLOCKED = 3; // threshold-ok: a block reason needs at least 3 signals to be listed
const MIN_UNCAUGHT = 3; // threshold-ok: a cause needs at least 3 uncaught gainers to be listed
const DATES_SHOWN = 3; // threshold-ok: at most 3 dates named
const PER_KIND = 2; // threshold-ok: at most 2 items of the same kind
const PERCENT = 100; // threshold-ok: percent

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  skipped_stop_distance: "the stop was too far away",
  skipped_cost_gate: "costs would eat the expected gain",
  skipped_week: "the weekly limit on new trades was reached",
};
const BLOCK_ACTION: Readonly<Record<string, string>> = {
  skipped_stop_distance: "Test a wider-stop variant of the strategies on the development data.",
  skipped_cost_gate: "Review the cost check for small positions on the development data.",
  skipped_week: "Review the weekly limit on new trades on the development data.",
};
export const blockWords = (r: string): string =>
  BLOCK_WORDS[r] ?? r.replace(/^skipped_/, "").replace(/_/g, " ");

const CAUSE_WORDS: Readonly<Record<MoverCause, string>> = {
  news_before_open: "moved on price-sensitive news before the open",
  news_during_day: "moved on price-sensitive news during the day",
  sector_move: "sector-wide moves",
  market_move: "market-wide moves",
  volume_no_news: "heavy trading without news",
  stock_specific: "stock-specific moves with no visible cause",
};
const CAUSE_ACTION: Readonly<Record<MoverCause, string>> = {
  sector_move:
    "Test a sector-strength factor on the shortlist; no strategy follows sector strength.",
  market_move:
    "Test a market-trend filter or a high-beta tilt; no strategy rides the whole market.",
  news_before_open:
    "Check why price-sensitive news before the open does not reach the picks the evening before.",
  news_during_day:
    "Only intraday watching can catch these; check that the intraday watch covers the busiest news names.",
  volume_no_news: "Test a volume-surge factor on the shortlist.",
  stock_specific: "Look for a missing data source (results, short interest) behind these moves.",
};

export type ImproveInput = {
  readonly d: string;
  readonly lessons: readonly FeatureLesson[];
  /** features whose hypothesis was opened tonight */
  readonly opened: readonly string[];
  /** features already proposed on an earlier night (so not opened again) */
  readonly alreadyOpen: ReadonlySet<string>;
  /** the last sessions (newest last) and which of them had no published pick; null = not known */
  readonly pickSessions: readonly string[] | null;
  readonly noPickDays: readonly string[];
  readonly blocked: { readonly signals: number; readonly byReason: ReadonlyMap<string, number> };
  /** stored nights of the last sessions with tonight's last: their movers say what no strategy caught */
  readonly history: readonly DailyLearning[];
  readonly gapMovers: number;
  readonly moversChecked: number;
};

export function buildImprovements(i: ImproveInput): ImprovementItem[] {
  const out: ImprovementItem[] = [];

  if (i.pickSessions !== null && i.noPickDays.length > 0) {
    const days = i.noPickDays
      .slice(-DATES_SHOWN)
      .map((x) => formatDay(x))
      .join(", ");
    out.push({
      title: "Publish a pick every trading night",
      evidence: `${i.noPickDays.length} of the last ${i.pickSessions.length} sessions had no published pick (${days}).`,
      action:
        "Check the strategy signals and the shortlist rule on those nights and why nothing passed.",
      area: "picks",
    });
  }

  const beats = i.lessons
    .filter((l) => l.verdict === "beats the market")
    .sort((a, b) => b.liftPpm - a.liftPpm || (a.feature < b.feature ? -1 : 1));
  for (const l of beats.slice(0, PER_KIND)) {
    const hit = Math.round((l.hitRatePpm * PERCENT) / PPM);
    out.push({
      title: `Evening setup that beats the market: ${l.feature}`,
      evidence: `Shares with this setup moved ${pct(l.nextDayAvgPpm)} the next day against ${pct(l.baseAvgPpm)} for the average liquid share (${l.n} share-days over ${l.sessions} sessions, ahead of the average on ${hit}% of them).`,
      action: i.opened.includes(l.feature)
        ? "Proposed as a shortlist factor; a hypothesis was opened for the Owner to review."
        : i.alreadyOpen.has(l.feature)
          ? "Proposed as a shortlist factor; its hypothesis is already open for review."
          : "Watch it: a hypothesis opens when it has beaten the market on 10 of the last 15 nights.",
      area: "learning",
    });
  }

  if (i.blocked.signals > 0) {
    const top = [...i.blocked.byReason.entries()]
      .filter(([, n]) => n >= MIN_BLOCKED)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    for (const [reason, n] of top.slice(0, PER_KIND)) {
      out.push({
        title: "Strategy signals blocked before they trade",
        evidence: `${n} of ${i.blocked.signals} strategy signals in the last ${LOOKBACK} sessions were blocked: ${blockWords(reason)}.`,
        action: BLOCK_ACTION[reason] ?? "Review the rule that blocks them on the development data.",
        area: "strategies",
      });
    }
  }

  // movers no strategy, pick or shortlist had on its radar, by cause (gainers over the stored nights)
  const nights = i.history.slice(-LOOKBACK);
  const gainers = nights.flatMap((n) => n.movers.filter((m) => m.side === "gainer"));
  const uncaught = gainers.filter((m) => m.caughtBy === null);
  const byCause = new Map<MoverCause, typeof uncaught>();
  for (const m of uncaught) byCause.set(m.cause, [...(byCause.get(m.cause) ?? []), m]);
  const causes = [...byCause.entries()]
    .filter(([, xs]) => xs.length >= MIN_UNCAUGHT)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  for (const [cause, xs] of causes.slice(0, PER_KIND)) {
    let where = "";
    if (cause === "sector_move") {
      const secs = new Map<string, number>();
      for (const m of xs)
        if (m.sectorName !== null) secs.set(m.sectorName, (secs.get(m.sectorName) ?? 0) + 1);
      const best = [...secs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      if (best !== undefined) where = ` (most in ${best[0]})`;
    }
    out.push({
      title: "Big gainers nothing had on the radar",
      evidence: `${xs.length} of ${gainers.length} top gainers in the last ${nights.length} ${nights.length === 1 ? "session" : "sessions"} were ${CAUSE_WORDS[cause]}${where}, and no strategy, pick or shortlist had them the evening before.`,
      action: CAUSE_ACTION[cause],
      area: cause === "stock_specific" || cause === "news_before_open" ? "data" : "strategies",
    });
  }

  if (i.gapMovers > 0) {
    out.push({
      title: "Price-data gaps among the top movers",
      evidence: `${i.gapMovers} of the ${i.moversChecked} biggest movers had missing price bars in the last 30 sessions.`,
      action: "Check the price-data feed and refill the missing days for those shares.",
      area: "data",
    });
  }
  return out.slice(0, MAX_IMPROVEMENTS);
}
