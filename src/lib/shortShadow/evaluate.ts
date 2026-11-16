// VAL-121 evaluation (M21 R1; D-1228, D-1297; BLD-051, CXA-015): the pre-registered hypothesis and its ONE look. The look is
// taken once, when the sample is met, and recorded as one row of `holdout_look` (lineage `short_shadow`); a second
// evaluation is refused and never re-computes. Below the sample nothing is written. No re-tuning: the selection and the
// scoring are fixed in select.ts and score.ts. The look reads the outcome table only and writes one registry row.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { HOLD_SESSIONS } from "./score";

export const SHORT_LINEAGE = "short_shadow";
export const MIN_SETUPS = 60; // threshold-ok: VAL-121 pre-registered sample
export const MIN_SESSIONS = 60; // threshold-ok: VAL-121 pre-registered sample
const READ_LIMIT = 20000; // threshold-ok: closed would-have shorts read for the one look

export const HYPOTHESIS_TEXT =
  "Would-have shorts are the 5 lowest-ranked gate-passing Cortex candidates of a session plus up to 5 names of tier U1 or U2 " +
  "with a polarity -1 event on day 0, that the market's short rules allow. Each is sold at the next open less slippage, " +
  "stopped at 10 % above the entry, otherwise covered at the open after 10 sessions, net of fees on both sides and the borrow fee. " +
  "The mean 10-session net, in parts per million of the entry value, is greater than 0, on at least 60 setups over at least 60 " +
  "sessions, with the one-sided 90 % block-bootstrap lower bound above 0. One look; never re-looked.";

/** The pre-registration fingerprint stored with the look (the hypothesis text, fixed). */
export const PREREG_SHA = createHash("sha256").update(HYPOTHESIS_TEXT).digest("hex").slice(0, 16); // threshold-ok: sha prefix

export type ShortEvaluation =
  | { readonly status: "refused"; readonly reason: "already_looked" }
  | { readonly status: "below_sample"; readonly setups: number; readonly sessions: number }
  | {
      readonly status: "looked";
      readonly verdict: "pass" | "fail";
      readonly setups: number;
      readonly sessions: number;
      readonly meanNetPpm: number;
      readonly lowerPpm: number | null;
    };

/** True once the one look of this market has been taken. */
export async function shortLookTaken(db: Client, market: string): Promise<boolean> {
  // rows-ok: a primary-key probe of the registry (lineage, market)
  const rs = await db.execute({
    sql: "SELECT 1 FROM holdout_look WHERE lineage = ? AND market = ?",
    args: [SHORT_LINEAGE, market],
  });
  return rs.rows.length > 0;
}

export async function evaluateShort(
  db: Client,
  o: { market: string; now: () => string },
): Promise<ShortEvaluation> {
  if (await shortLookTaken(db, o.market)) return { status: "refused", reason: "already_looked" };
  // rows-ok: the closed would-have shorts of one market, bounded by LIMIT; read once, in the primary key order
  const rs = await db.execute({
    sql: `SELECT d, code, net_ppm FROM short_shadow_outcome
          WHERE market = ? AND status = 'closed' AND net_ppm IS NOT NULL ORDER BY d, code, origin LIMIT ?`,
    args: [o.market, READ_LIMIT],
  });
  const dates = [...new Set(rs.rows.map((r) => String(r.d)))].sort();
  if (rs.rows.length < MIN_SETUPS || dates.length < MIN_SESSIONS) {
    return { status: "below_sample", setups: rs.rows.length, sessions: dates.length };
  }
  const ix = new Map(dates.map((x, i) => [x, i]));
  const net = rs.rows.map((r) => Number(r.net_ppm)); // money-float-ok: ppm integers into the statistic
  const mean = net.reduce((a, b) => a + b, 0) / net.length;
  const boot = bootstrapMean(
    {
      sessions: rs.rows.map((r) => ix.get(String(r.d))!),
      sessionCount: dates.length,
      codes: rs.rows.map((r) => String(r.code)),
    },
    net,
    scopedPrng(`boot:${SHORT_LINEAGE}:${o.market}`),
    { expectedBlock: HOLD_SESSIONS, maxHold: HOLD_SESSIONS },
  );
  const lower = isUndefined(boot) ? null : boot.oneSidedLo;
  const verdict = mean > 0 && lower !== null && lower > 0 ? "pass" : "fail";
  const ins = await db.execute({
    sql: `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [SHORT_LINEAGE, o.market, o.now(), PREREG_SHA, verdict],
  });
  if (ins.rowsAffected === 0) return { status: "refused", reason: "already_looked" };
  return {
    status: "looked",
    verdict,
    setups: rs.rows.length,
    sessions: dates.length,
    meanNetPpm: mean,
    lowerPpm: lower,
  };
}
