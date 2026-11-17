// DAT-248 evaluation (M22 E5, D-1440; BLD-051, CXA-015): the pre-registered hypothesis and its ONE look. Hypothesis: on sessions
// where the alt reading is more cautious than the base, the next-20-session return of the market's benchmark index is lower
// than on the other sessions. Sample: forward readings with an outside input (status ok or partial) whose 20-session return is
// known, at least 30 of them differing sessions. Statistic: mean return on the other sessions minus mean on the differing
// ones, in parts per million, evaluated as the mean of weighted rows (weight N/N_other for the others, -N/N_differing for the
// differing) so the stationary block bootstrap of the stats library applies; the one-sided 90 % lower bound above 0 is a PASS.
// The look is one row in `holdout_look` (lineage `regime_altinputs`) through the registry gate (M23 A2); a second evaluation is refused, audited and computes nothing. A PASS
// only lets the Owner consider a gate change in a later spec version: nothing here changes any gate.
import type { Client } from "@libsql/client";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { loadProfile } from "@/lib/market/profile";
import {
  canonicalJson,
  preregister,
  sha256Hex,
  takeLook,
  type LookComputed,
} from "@/lib/research/registry";
import { moreCautious } from "./rule";

export const ALT_LINEAGE = "regime_altinputs";
export const FORWARD_SESSIONS = 20; // threshold-ok: DAT-248 pre-registered return horizon
export const MIN_DIFFERING = 30; // threshold-ok: DAT-248 pre-registered sample (differing sessions)
const READ_LIMIT = 2000; // threshold-ok: readings read for the one look (about eight years of sessions)
const BARS_LIMIT = 2600; // threshold-ok: benchmark closes read for the look

export const HYPOTHESIS_TEXT =
  "On forward sessions where the regime reading with outside signals is more cautious than the base reading, the benchmark " +
  "index return over the next 20 sessions is lower than on the other sessions with an outside signal. The statistic is the mean " +
  "return of the other sessions minus the mean of the differing sessions; the sample is at least 30 differing sessions; the " +
  "one-sided 90 % block-bootstrap lower bound must be above 0. One look; never re-looked. A pass lets the Owner consider a " +
  "gate change in a later specification version only.";
/** The frozen plan: the hypothesis text. Its sha256 (64 hex) is the registry hash stored with the look (M23 A2). */
export const FROZEN_PLAN = { hypothesis: HYPOTHESIS_TEXT } as const;
export const PREREG_SHA = sha256Hex(canonicalJson(FROZEN_PLAN));

export type AltEvaluation =
  | { readonly status: "refused"; readonly reason: "already_looked" }
  | { readonly status: "below_sample"; readonly differing: number; readonly sessions: number }
  | {
      readonly status: "looked";
      readonly verdict: "pass" | "fail";
      readonly differing: number;
      readonly sessions: number;
      readonly differencePpm: number;
      readonly lowerPpm: number | null;
    };

/** True once the one look of this market has been taken. */
export async function altLookTaken(db: Client, market: string): Promise<boolean> {
  // rows-ok: a primary-key probe of the registry (lineage, market)
  const rs = await db.execute({
    sql: "SELECT 1 FROM holdout_look WHERE lineage = ? AND market = ?",
    args: [ALT_LINEAGE, market],
  });
  return rs.rows.length > 0;
}

type Point = { d: string; differing: boolean; retPpm: number };

/** The sample: readings with an outside input and a known 20-session return. */
async function sampleOf(db: Client, market: string): Promise<Point[]> {
  const prof = await loadProfile(db, market);
  const index = prof.benchmarkIndex;
  if (index === null) return [];
  // rows-ok: regime_alt_reading primary key (market, d), oldest first, LIMIT 2000
  const rd = await db.execute({
    sql: `SELECT d, base_state, alt_state FROM regime_alt_reading
           WHERE market = ? AND inputs_status <> 'unavailable' ORDER BY d LIMIT ?`,
    args: [market, READ_LIMIT],
  });
  if (rd.rows.length === 0) return [];
  const first = String(rd.rows[0]!.d);
  // rows-ok: index_bar primary key (market, index_code, d) from the first reading on, LIMIT 2600
  const bars = await db.execute({
    sql: `SELECT d, c_micro FROM index_bar WHERE market = ? AND index_code = ? AND d >= ? ORDER BY d LIMIT ?`,
    args: [market, index, first, BARS_LIMIT],
  });
  const closes = bars.rows.map((b) => ({ d: String(b.d), c: Number(b.c_micro) }));
  const at = new Map(closes.map((c, i) => [c.d, i]));
  const out: Point[] = [];
  for (const r of rd.rows) {
    const i = at.get(String(r.d));
    if (i === undefined) continue;
    const later = closes[i + FORWARD_SESSIONS];
    const now = closes[i]!;
    if (later === undefined || now.c <= 0) continue;
    out.push({
      d: now.d,
      differing: moreCautious(String(r.base_state), String(r.alt_state)),
      retPpm: Math.round(((later.c - now.c) * 1_000_000) / now.c), // money-float-ok: an index return in ppm for the statistic
    });
  }
  return out;
}

type Measured =
  | { below: true; detail: Extract<AltEvaluation, { status: "below_sample" }> }
  | { below: false; detail: Extract<AltEvaluation, { status: "looked" }>; computed: LookComputed };

/** Reads the sample once and measures it; "below" when the pre-registered sample is not met. */
async function measure(db: Client, market: string): Promise<Measured> {
  const pts = await sampleOf(db, market);
  const diff = pts.filter((p) => p.differing);
  const rest = pts.filter((p) => !p.differing);
  if (diff.length < MIN_DIFFERING || rest.length === 0) {
    return {
      below: true,
      detail: { status: "below_sample", differing: diff.length, sessions: pts.length },
    };
  }
  const n = pts.length;
  const values = pts.map(
    (p) => ((p.differing ? -1 : 1) * (p.retPpm * n)) / (p.differing ? diff.length : rest.length),
  );
  const difference = values.reduce((a, b) => a + b, 0) / n;
  const boot = bootstrapMean(
    { sessions: pts.map((_, i) => i), sessionCount: n },
    values,
    scopedPrng(`boot:${ALT_LINEAGE}:${market}`),
    { expectedBlock: FORWARD_SESSIONS, maxHold: FORWARD_SESSIONS },
  );
  const lower = isUndefined(boot) ? null : boot.oneSidedLo;
  const pass = difference > 0 && lower !== null && lower > 0;
  return {
    below: false,
    detail: {
      status: "looked",
      verdict: pass ? "pass" : "fail",
      differing: diff.length,
      sessions: n,
      differencePpm: difference,
      lowerPpm: lower,
    },
    computed: {
      verdict: pass ? "PASS" : "NULL",
      nSetups: diff.length,
      nBlocks: Math.ceil(n / FORWARD_SESSIONS),
      stats: { differencePpm: difference, lowerPpm: lower, sessions: n },
    },
  };
}

/**
 * The one look (D-1666). A look already on file goes straight to the gate, which refuses and audits it; otherwise the sample
 * is read and, when it is met, the plan is frozen and the look taken. Below the sample nothing at all is written.
 */
export async function evaluateAlt(
  db: Client,
  o: { market: string; now: () => string },
): Promise<AltEvaluation> {
  const now = o.now();
  const m = (await altLookTaken(db, o.market)) ? null : await measure(db, o.market);
  if (m !== null && m.below) return m.detail;
  const plan = await preregister(db, {
    lineage: ALT_LINEAGE,
    market: o.market,
    item: "DAT-248",
    frozen: FROZEN_PLAN,
    now,
  });
  const r = await takeLook(db, {
    lineage: ALT_LINEAGE,
    market: o.market,
    sha: plan.sha,
    caller: "regime_altinputs",
    now,
    compute: () => (m === null || m.below ? never() : m.computed),
  });
  if (r.status === "refused" && r.reason === "not_preregistered") {
    throw new Error("the outside-signal test plan could not be frozen");
  }
  if (r.status === "refused" || m === null || m.below) {
    return { status: "refused", reason: "already_looked" };
  }
  return m.detail;
}

function never(): never {
  throw new Error("the gate computed a look that was already on file");
}
