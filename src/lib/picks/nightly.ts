// The nightly picks phase (AGT-113 + ARN-095). Runs after batch 3 and after AGT-112 (the factor
// buckets are READ here), before the Evening Review. It first follows the open picks through the
// bars up to D (tracking), then publishes tonight's picks. Idempotent for the same night: the same
// state writes nothing new. Wiring it into the batch 3 phase list is T11/T18's task; nothing in
// the trading path calls it.
import type { Client } from "@libsql/client";
import type { AgentParams } from "@/lib/agents/params";
import type { CalendarRow } from "@/lib/data/calendar";
import { isTradingDay } from "@/lib/data/calendar";
import { generatePicks } from "./generate";
import { loadPickInputs } from "./inputs";
import { writePicks } from "./store";
import { trackPicks, type TrackSummary } from "./track";

export type PicksNightResult = {
  readonly published: number;
  readonly candidates: number;
  readonly tracking: TrackSummary;
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
  if (!isTradingDay(o.d, o.calendar) || o.params.picks.picksPerProfile === 0) {
    return { published: 0, candidates: 0, tracking };
  }
  const { inputs, universe } = await loadPickInputs(db, {
    market: o.market,
    d: o.d,
    params: o.params,
    calendar: o.calendar,
  });
  const picks = generatePicks(inputs, {
    market: o.market,
    d: o.d,
    calendar: o.calendar,
    picks: o.params.picks,
    universe,
    createdAt: o.now,
  });
  const published = await writePicks(db, picks);
  return { published, candidates: inputs.length, tracking };
}
