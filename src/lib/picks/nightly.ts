// The nightly picks phase (AGT-113 + ARN-095). Runs after batch 3 and after AGT-112 (the factor
// buckets are READ here), before the Evening Review. It first follows the open picks through the
// bars up to D (tracking), checks the picks still waiting against tonight's information (D-187,
// ./validity.ts), then publishes tonight's picks. Idempotent for the same night: the same
// state writes nothing new. Wiring it into the batch 3 phase list is T11/T18's task; nothing in
// the trading path calls it.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { CalendarRow } from "@/lib/data/calendar";
import { isTradingDay } from "@/lib/data/calendar";
import { generatePicks } from "./generate";
import { loadPickInputs } from "./inputs";
import { countBlocks, noPicksSentence, type BlockCounts } from "./noPicks";
import { writePicks } from "./store";
import { loadShortlistInputs } from "./shortlistLoad";
import type { PickInput } from "./types";
import { trackPicks, type TrackSummary } from "./track";
import { checkWaitingPicks, type CheckSummary } from "./validity";

export type PicksNightResult = {
  readonly published: number;
  readonly candidates: number;
  /** D-920: shortlist candidates added to the strategy signals tonight (-1 when the shortlist failed). */
  readonly shortlist: number;
  /** OPS-110: first blocking reason per candidate (empty on a non-trading day). */
  readonly blocked: BlockCounts;
  /** OPS-110: plain-words reason when nothing was published on a trading day, else null. */
  readonly noPicksLine: string | null;
  readonly tracking: TrackSummary;
  readonly checks: CheckSummary;
};

export async function runPicksNight(
  db: Client,
  o: {
    market: string;
    d: string;
    params: AgentParams;
    calendar: readonly CalendarRow[];
    /** ISO instant stamped on the picks (the caller's clock; never read here). */
    now: string;
    costProfile?: string;
  },
): Promise<PicksNightResult> {
  const tracking = await trackPicks(db, {
    market: o.market,
    d: o.d,
    costProfile: o.costProfile,
    advWindow: o.params.windows.adv,
  });
  const checks = await checkWaitingPicks(db, {
    market: o.market,
    d: o.d,
    calendar: o.calendar,
    now: o.now,
  });
  if (!isTradingDay(o.d, o.calendar) || o.params.picks.picksPerProfile === 0) {
    return {
      published: 0,
      candidates: 0,
      shortlist: 0,
      blocked: {},
      noPicksLine: null,
      tracking,
      checks,
    };
  }
  const { inputs, universe } = await loadPickInputs(db, {
    market: o.market,
    d: o.d,
    params: o.params,
    calendar: o.calendar,
  });
  // D-920: the nightly shortlist fills the places the strategy signals leave empty (never blocks them)
  let shortlist: PickInput[] = [];
  let shortlistCount = 0;
  try {
    shortlist = await loadShortlistInputs(db, {
      market: o.market,
      d: o.d,
      exclude: new Set(inputs.map((x) => x.code)),
      costProfile: o.costProfile,
    });
    shortlistCount = shortlist.length;
  } catch {
    shortlistCount = -1;
  }
  const picks = generatePicks([...inputs, ...shortlist], {
    market: o.market,
    d: o.d,
    calendar: o.calendar,
    picks: o.params.picks,
    universe,
    createdAt: o.now,
  });
  const published = await writePicks(db, picks);
  const blocked = countBlocks([...inputs, ...shortlist]);
  const noPicksLine =
    published > 0
      ? null
      : noPicksSentence({
          signals: inputs.length,
          shortlist: shortlistCount,
          blocked: countBlocks(inputs),
        });
  return {
    published,
    candidates: inputs.length,
    shortlist: shortlistCount,
    blocked,
    noPicksLine,
    tracking,
    checks,
  };
}
