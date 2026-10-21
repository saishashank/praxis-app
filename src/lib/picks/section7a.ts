// Evening Review section 7a "New picks" (UXN-044, s13: after section 7, numbering 1-10 unchanged),
// read from the STORED picks of the review date and the stored outcomes (no recomputation, no
// LLM). Per profile: company, buy up to, stop-loss, aim, time frame, one Based-on line and a link,
// plus the one-line model-success figure (UXN-041). The facts carry micro-AUD; the review section
// reader turns them into whole cents like every other section.
import type { Client } from "@libsql/client";
import type { PicksParams } from "@/lib/agents/params";
import { modelSuccess, successLine } from "./success";

type Db = Pick<Client, "execute">;

/** Sessions in a trading week, for "about N weeks" (UXN-040). */
const SESSIONS_PER_WEEK = 5; // threshold-ok: weekdays per week, display unit only

export type Section7aPick = {
  readonly code: string;
  readonly rank: number;
  readonly buyUpToMicro: bigint;
  readonly validUntilD: string;
  readonly stopMicro: bigint;
  readonly aimMicro: bigint;
  /** "about N weeks", at least 1; null when no time frame is stored. */
  readonly timeFrameWeeks: number | null;
  /** First Based-on line, or null. */
  readonly basedOn: string | null;
  readonly link: string;
};

export type Section7aProfile = {
  readonly profile: string;
  readonly picks: readonly Section7aPick[];
  readonly successLine: string;
};

export type Section7aFacts = {
  readonly d: string;
  readonly profiles: readonly Section7aProfile[];
  /** true when no profile published a pick tonight. */
  readonly none: boolean;
  /** Every profile's live record beats its luck check (UXN-045 drops "Model not proven yet"). */
  readonly proven: boolean;
};

export async function readSection7a(
  db: Db,
  q: { market: string; d: string; appUrl: string; picks: PicksParams; confidence: number },
): Promise<Section7aFacts> {
  const profiles: Section7aProfile[] = [];
  let any = false;
  let proven = true;
  for (const profile of Object.keys(q.picks.profiles).sort()) {
    const r = await db.execute({
      sql: `SELECT rank, code, buy_max_micro, valid_until_d, stop_micro, aim_micro,
                   time_frame_sessions, based_on_json
            FROM pick WHERE market = ? AND d = ? AND profile = ? ORDER BY rank`,
      args: [q.market, q.d, profile],
    });
    const picks: Section7aPick[] = r.rows.map((x) => {
      const basedOn = JSON.parse(String(x.based_on_json)) as string[];
      const sessions = x.time_frame_sessions === null ? null : Number(x.time_frame_sessions); // money-float-ok: SQL integer column
      return {
        code: String(x.code),
        rank: Number(x.rank), // money-float-ok: SQL integer column
        buyUpToMicro: BigInt(String(x.buy_max_micro)),
        validUntilD: String(x.valid_until_d),
        stopMicro: BigInt(String(x.stop_micro)),
        aimMicro: BigInt(String(x.aim_micro)),
        timeFrameWeeks:
          sessions === null ? null : Math.max(1, Math.round(sessions / SESSIONS_PER_WEEK)),
        basedOn: basedOn.length > 0 ? basedOn[0]! : null,
        link: `${q.appUrl}/picks?d=${q.d}&profile=${profile}`,
      };
    });
    if (picks.length > 0) any = true;
    const s = await modelSuccess(db, {
      market: q.market,
      profile,
      d: q.d,
      minN: q.picks.pickSuccessMinN,
      confidence: q.confidence,
    });
    if (!s.beatsLuck) proven = false;
    profiles.push({ profile, picks, successLine: successLine(s) });
  }
  return { d: q.d, profiles, none: !any, proven };
}
