// D-1069 (Owner O-84): the loader of the "Replay check" section of the Track record page. Reads the
// newest stored scorecard run (one indexed read, no OFFSET) and returns only aggregates: counts and
// percentages, no stock code or name. The dates are trading words for an unmasked viewer and ISO
// weeks for a masked one (DAT-124). Nothing here writes, and nothing a learner or promotion test reads.
import { loadLatestScorecard } from "@/lib/scorecard/pickScorecardStore";
import type { ScorecardSummary } from "@/lib/scorecard/pickScorecard";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { formatDay, isoWeek, MISSING } from "@/lib/view/format";
import type { LoaderEnv } from "./shell";

export type ReplayCheckView = {
  readonly sessions: number;
  readonly masked: boolean;
  /** "Mon 12 Oct to Fri 6 Nov" (unmasked) or "2026-W42 to 2026-W45" (masked). */
  readonly range: string;
  readonly summary: ScorecardSummary;
  readonly partial: boolean;
};

export async function loadReplayCheck(env: LoaderEnv): Promise<ReplayCheckView | null> {
  let run;
  try {
    run = await loadLatestScorecard(env.main, env.market ?? HOME_MARKET);
  } catch {
    return null; // a database without the table (older schema): no section
  }
  if (run === null) return null;
  const masked = env.mask.masked;
  const day = (d: string): string => (masked ? (isoWeek(d) ?? MISSING) : formatDay(d, env.now));
  return {
    sessions: run.sessions,
    masked,
    range: `${day(run.firstD)} to ${day(run.lastD)}`,
    summary: run.summary,
    partial: run.status === "partial",
  };
}
