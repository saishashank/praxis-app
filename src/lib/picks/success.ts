// ARN-095 success statistic ("Model success", UXN-041): the share of CLOSED picks that made money
// after costs, per profile, with n, a Wilson interval at `cif_confidence`, the luck-check figure and
// the share inside the published bad-good range. Missed picks are neither a win nor a loss. Until
// `pick_success_min_n` picks of the profile are closed the figure is "not measured yet" and no
// percentage is produced at all. Everything is read from stored outcome rows, bounded by D.
import type { Client } from "@libsql/client";
import { wilsonInterval } from "@/lib/stats/binomial";

type Db = Pick<Client, "execute">;

const PERCENT = 100; // threshold-ok: percent base
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ModelSuccess = {
  readonly profile: string;
  /** false until n closed >= pick_success_min_n. */
  readonly measured: boolean;
  /** Confidence level of the interval, whole percent. */
  readonly confidencePct: number;
  readonly minN: number;
  readonly closed: number;
  /** Published picks still waiting or bought as of D. */
  readonly open: number;
  readonly missed: number;
  readonly wins: number;
  /** Whole percent, null when not measured. */
  readonly winPct: number | null;
  readonly lowerPct: number | null;
  readonly upperPct: number | null;
  readonly luckClosed: number;
  readonly luckWins: number;
  readonly luckPct: number | null;
  /** Share of closed picks that landed inside their published bad-good range (whole percent). */
  readonly insidePct: number | null;
  /** Date of the first published pick of the profile. */
  readonly since: string | null;
  /** The live record beats the luck check (lower bound of the pick interval above the twin rate). */
  readonly beatsLuck: boolean;
};

/** Whole percent of k / n, half up, integers only. */
export function wholePercent(k: number, n: number): number {
  return Math.floor((2 * PERCENT * k + n) / (2 * n));
}

export async function modelSuccess(
  db: Db,
  q: { market: string; profile: string; d: string; minN: number; confidence: number },
): Promise<ModelSuccess> {
  const r = await db.execute({
    sql: `SELECT o.kind, o.state, o.net_micro, o.net_ppm, o.exit_d, p.bad_ppm, p.good_ppm, p.d AS pub_d
          FROM pick_outcome o JOIN pick p
            ON p.market = o.market AND p.d = o.d AND p.profile = o.profile AND p.rank = o.rank
          WHERE o.market = ? AND o.profile = ? AND p.d <= ?`,
    args: [q.market, q.profile, q.d],
  });
  let closed = 0;
  let wins = 0;
  let open = 0;
  let missed = 0;
  let luckClosed = 0;
  let luckWins = 0;
  let inside = 0;
  let since: string | null = null;
  for (const x of r.rows) {
    const pub = String(x.pub_d);
    if (since === null || pub < since) since = pub;
    const isClosed = String(x.state) === "closed" && String(x.exit_d) <= q.d;
    const win = isClosed && BigInt(String(x.net_micro)) > 0n;
    if (String(x.kind) === "luck") {
      if (isClosed) {
        luckClosed += 1;
        if (win) luckWins += 1;
      }
      continue;
    }
    if (isClosed) {
      closed += 1;
      if (win) wins += 1;
      const net = Number(x.net_ppm); // money-float-ok: SQL integer column
      if (net >= Number(x.bad_ppm) && net <= Number(x.good_ppm)) inside += 1; // money-float-ok: SQL integer columns
    } else if (String(x.state) === "missed") {
      missed += 1;
    } else {
      open += 1;
    }
  }
  const measured = closed >= q.minN && closed > 0;
  const ci = measured ? wilsonInterval(wins, closed, q.confidence) : null;
  const luckRate = luckClosed > 0 ? luckWins / luckClosed : null;
  return {
    profile: q.profile,
    measured,
    confidencePct: Math.round(q.confidence * PERCENT),
    minN: q.minN,
    closed,
    open,
    missed,
    wins,
    winPct: measured ? wholePercent(wins, closed) : null,
    lowerPct: ci === null ? null : Math.round(ci.lower * PERCENT),
    upperPct: ci === null ? null : Math.round(ci.upper * PERCENT),
    luckClosed,
    luckWins,
    luckPct: luckClosed > 0 ? wholePercent(luckWins, luckClosed) : null,
    insidePct: measured ? wholePercent(inside, closed) : null,
    since,
    beatsLuck: ci !== null && luckRate !== null && luckClosed >= q.minN && ci.lower > luckRate,
  };
}

/** "1 Oct" from an ISO date. */
export function shortDate(d: string): string {
  const [, m, day] = d.split("-");
  return `${Number(day)} ${MONTHS[Number(m) - 1]}`; // money-float-ok: calendar digits
}

/** The one-line strip (UXN-041 wording) for a profile. */
export function successLine(s: ModelSuccess): string {
  if (!s.measured) {
    return `Model success: not measured yet — ${s.closed} of ${s.minN} picks closed`;
  }
  const luck = s.luckPct === null ? "luck check not measured yet" : `luck check ${s.luckPct}%`;
  const since = s.since === null ? "" : ` · since ${shortDate(s.since)}`;
  return (
    `Model success: ${s.winPct}% of ${s.closed} closed picks made money ` +
    `(${s.confidencePct}% range ${s.lowerPct}–${s.upperPct}%, ${s.open} still open) · ${luck}${since}`
  );
}
