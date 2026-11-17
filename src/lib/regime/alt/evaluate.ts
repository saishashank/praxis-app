// DAT-248 evaluation (M22 E5, D-1440; BLD-051, CXA-015): the pre-registered hypothesis and its ONE look. Hypothesis: on sessions
// where the alt reading is more cautious than the base, the next-20-session return of the market's benchmark index is lower
// than on the other sessions. Sample: forward readings with an outside input (status ok or partial) whose 20-session return is
// known, at least 30 of them differing sessions. Statistic: mean return on the other sessions minus mean on the differing
// ones, in parts per million, evaluated as the mean of weighted rows (weight N/N_other for the others, -N/N_differing for the
// differing) so the stationary block bootstrap of the stats library applies; the one-sided 90 % lower bound above 0 is a PASS.
// The look is one row in `holdout_look` (lineage `regime_altinputs`); a second evaluation is refused and computes nothing. A PASS
// only lets the Owner consider a gate change in a later spec version: nothing here changes any gate.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { bootstrapMean, isUndefined } from "@/lib/stats/stationaryBootstrap";
import { scopedPrng } from "@/lib/stats/rng";
import { loadProfile } from "@/lib/market/profile";
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
export const PREREG_SHA = createHash("sha256").update(HYPOTHESIS_TEXT).digest("hex").slice(0, 16); // threshold-ok: sha prefix

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
export async function altLookTaken(db: Pick<Client, "execute">, market: string): Promise<boolean> {
  // rows-ok: a primary-key probe of the registry (lineage, market)
  const rs = await db.execute({
    sql: "SELECT 1 FROM holdout_look WHERE lineage = ? AND market = ?",
    args: [ALT_LINEAGE, market],
  });
  return rs.rows.length > 0;
}

type Point = { d: string; differing: boolean; retPpm: number };

/** The sample: readings with an outside input and a known 20-session return. */
async function sampleOf(db: Pick<Client, "execute">, market: string): Promise<Point[]> {
  const prof = await loadProfile(db as Client, market);
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

export async function evaluateAlt(
  db: Pick<Client, "execute">,
  o: { market: string; now: () => string },
): Promise<AltEvaluation> {
  if (await altLookTaken(db, o.market)) return { status: "refused", reason: "already_looked" };
  const pts = await sampleOf(db, o.market);
  const diff = pts.filter((p) => p.differing);
  const rest = pts.filter((p) => !p.differing);
  if (diff.length < MIN_DIFFERING || rest.length === 0) {
    return { status: "below_sample", differing: diff.length, sessions: pts.length };
  }
  const n = pts.length;
  const values = pts.map(
    (p) => ((p.differing ? -1 : 1) * (p.retPpm * n)) / (p.differing ? diff.length : rest.length),
  );
  const difference = values.reduce((a, b) => a + b, 0) / n;
  const boot = bootstrapMean(
    { sessions: pts.map((_, i) => i), sessionCount: n },
    values,
    scopedPrng(`boot:${ALT_LINEAGE}:${o.market}`),
    { expectedBlock: FORWARD_SESSIONS, maxHold: FORWARD_SESSIONS },
  );
  const lower = isUndefined(boot) ? null : boot.oneSidedLo;
  const verdict = difference > 0 && lower !== null && lower > 0 ? "pass" : "fail";
  const ins = await db.execute({
    sql: `INSERT INTO holdout_look (lineage, market, looked_at, prereg_sha, verdict)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [ALT_LINEAGE, o.market, o.now(), PREREG_SHA, verdict],
  });
  if (ins.rowsAffected === 0) return { status: "refused", reason: "already_looked" };
  return {
    status: "looked",
    verdict,
    differing: diff.length,
    sessions: n,
    differencePpm: difference,
    lowerPpm: lower,
  };
}
