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
import { generatePicks, type ExistingPick } from "./generate";
import { loadPickInputs } from "./inputs";
import { countBlocks, noPicksSentence, type BlockCounts } from "./noPicks";
import { writePicks } from "./store";
import { loadShortlistInputs } from "./shortlistLoad";
import { loadCandidateInputs } from "./candidates";
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
  /** D-980: candidate-measure inputs offered tonight (-1 when that step failed). */
  readonly candidateMeasures: number;
  readonly tracking: TrackSummary;
  readonly checks: CheckSummary;
  /** D-1856: on a dated rerun, the published picks kept and the strategy picks added after them. */
  readonly appended?: { readonly kept: number; readonly added: number };
};

/** D-1856: the session's published picks per profile (rank, company, family), oldest rank first. */
async function loadPublished(
  db: Client,
  market: string,
  d: string,
): Promise<Map<string, ExistingPick[]>> {
  const rs = await db.execute({
    sql: `SELECT profile, rank, code, family FROM pick WHERE market = ? AND d = ? ORDER BY profile, rank`,
    args: [market, d],
  });
  const out = new Map<string, ExistingPick[]>();
  for (const r of rs.rows) {
    const profile = String(r.profile);
    const list = out.get(profile) ?? [];
    list.push({ rank: Number(r.rank), code: String(r.code), family: String(r.family) });
    out.set(profile, list);
  }
  return out;
}

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
    /**
     * D-1856: the Owner's dated rerun of a past session. The picks already published for it stay as they
     * are; tonight's strategy picks are added after them (next rank up to 10). No shortlist or
     * candidate-measure picks are added: the rerun is for the strategy signals the late bars allow.
     */
    appendAfterPublished?: boolean;
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
      candidateMeasures: 0,
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
  if (o.appendAfterPublished === true) {
    const existing = await loadPublished(db, o.market, o.d);
    const picks = generatePicks(inputs, {
      market: o.market,
      d: o.d,
      calendar: o.calendar,
      picks: o.params.picks,
      universe,
      createdAt: o.now,
      existing,
    });
    const published = await writePicks(db, picks);
    return {
      published,
      candidates: inputs.length,
      shortlist: 0,
      candidateMeasures: 0,
      blocked: countBlocks(inputs),
      noPicksLine: null,
      tracking,
      checks,
      appended: {
        kept: [...existing.values()].reduce((n, l) => n + l.length, 0),
        added: published,
      },
    };
  }
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
  // D-980: the candidate measures' picks, after the strategy and shortlist picks (never displace them)
  let candidates: PickInput[] = [];
  let candidateCount = 0;
  try {
    candidates = await loadCandidateInputs(db, {
      market: o.market,
      d: o.d,
      exclude: new Set([...inputs, ...shortlist].map((x) => x.code)),
    });
    candidateCount = candidates.length;
  } catch {
    candidateCount = -1;
  }
  const picks = generatePicks(
    [...inputs, ...shortlist],
    {
      market: o.market,
      d: o.d,
      calendar: o.calendar,
      picks: o.params.picks,
      universe,
      createdAt: o.now,
    },
    { inputs: candidates, perProfile: candidates.length },
  );
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
    candidateMeasures: candidateCount,
    blocked,
    noPicksLine,
    tracking,
    checks,
  };
}
