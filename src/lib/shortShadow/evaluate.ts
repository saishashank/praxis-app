// VAL-121 evaluation (M21 R1; D-1228, D-1297; BLD-051, CXA-015): the pre-registered hypothesis and its ONE look. The look is
// taken once, when the sample is met, and recorded as one row of `holdout_look` (lineage `short_shadow`) through
// the registry gate (M23 A2: `preregister` and `takeLook`, which refuses, audits and never re-computes a second look). Below the sample nothing is written. No re-tuning: the selection and the
// scoring are fixed in select.ts and score.ts. The look reads the outcome table only and writes one registry row.
import type { Client } from "@libsql/client";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import {
  canonicalJson,
  preregister,
  sha256Hex,
  takeLook,
  type LookComputed,
} from "@/lib/research/registry";
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

/** The frozen plan: the hypothesis text. Its sha256 (64 hex) is the registry hash stored with the look (M23 A2). */
export const FROZEN_PLAN = { hypothesis: HYPOTHESIS_TEXT } as const;
export const PREREG_SHA = sha256Hex(canonicalJson(FROZEN_PLAN));

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

type Measured =
  | { below: true; detail: Extract<ShortEvaluation, { status: "below_sample" }> }
  | {
      below: false;
      detail: Extract<ShortEvaluation, { status: "looked" }>;
      computed: LookComputed;
    };

/** Reads the closed would-have shorts once and measures them; "below" when the pre-registered sample is not met. */
async function measure(db: Client, market: string): Promise<Measured> {
  // rows-ok: the closed would-have shorts of one market, bounded by LIMIT; read once, in the primary key order
  const rs = await db.execute({
    sql: `SELECT d, code, net_ppm FROM short_shadow_outcome
          WHERE market = ? AND status = 'closed' AND net_ppm IS NOT NULL ORDER BY d, code, origin LIMIT ?`,
    args: [market, READ_LIMIT],
  });
  const dates = [...new Set(rs.rows.map((r) => String(r.d)))].sort();
  if (rs.rows.length < MIN_SETUPS || dates.length < MIN_SESSIONS) {
    return {
      below: true,
      detail: { status: "below_sample", setups: rs.rows.length, sessions: dates.length },
    };
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
    scopedPrng(`boot:${SHORT_LINEAGE}:${market}`),
    { expectedBlock: HOLD_SESSIONS, maxHold: HOLD_SESSIONS },
  );
  const lower = isUndefined(boot) ? null : boot.oneSidedLo;
  const pass = mean > 0 && lower !== null && lower > 0;
  return {
    below: false,
    detail: {
      status: "looked",
      verdict: pass ? "pass" : "fail",
      setups: rs.rows.length,
      sessions: dates.length,
      meanNetPpm: mean,
      lowerPpm: lower,
    },
    computed: {
      verdict: pass ? "PASS" : "NULL",
      nSetups: rs.rows.length,
      nBlocks: Math.ceil(dates.length / HOLD_SESSIONS),
      stats: { meanNetPpm: mean, lowerPpm: lower, sessions: dates.length },
    },
  };
}

/**
 * The one look (D-1666). A look already on file goes straight to the gate, which refuses and audits it; otherwise the sample
 * is read and, when it is met, the plan is frozen and the look taken. Below the sample nothing at all is written.
 */
export async function evaluateShort(
  db: Client,
  o: { market: string; now: () => string },
): Promise<ShortEvaluation> {
  const now = o.now();
  const m = (await shortLookTaken(db, o.market)) ? null : await measure(db, o.market);
  if (m !== null && m.below) return m.detail;
  const plan = await preregister(db, {
    lineage: SHORT_LINEAGE,
    market: o.market,
    item: "VAL-121",
    frozen: FROZEN_PLAN,
    now,
  });
  const r = await takeLook(db, {
    lineage: SHORT_LINEAGE,
    market: o.market,
    sha: plan.sha,
    caller: "short_shadow",
    now,
    compute: () => (m === null || m.below ? never() : m.computed),
  });
  if (r.status === "refused" && r.reason === "not_preregistered") {
    throw new Error("the short-selling test plan could not be frozen");
  }
  if (r.status === "refused" || m === null || m.below) {
    return { status: "refused", reason: "already_looked" };
  }
  return m.detail;
}

function never(): never {
  throw new Error("the gate computed a look that was already on file");
}
