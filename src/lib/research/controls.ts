// Research engine, matched controls (M23 R1; D-1627). Pure and seeded. A control for a setup is another code of the same
// session's pool that shares the setup's tier and (unless the lineage says otherwise) volatility decile; up to `k` are
// drawn without replacement by a partial Fisher-Yates shuffle of the code-sorted eligible list, from a PRNG scoped to the
// lineage, code and session, so the draw never depends on call order. The controls are then run through the SAME entry,
// exit and cost rule as the setup (eventStudy), so the excess is like for like.
import { belowInt, scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";

export type MatchKey = "tier" | "volDecile";

export type ControlCandidate = {
  readonly code: string;
  readonly tier?: string;
  readonly volDecile?: number;
};

/** The pool of a session's eligible codes (point-in-time, built by the caller). */
export type ControlPool = (session: number) => readonly ControlCandidate[];

/** True when `candidate` matches `subject` on every key in `matchOn`. */
export function matches(
  subject: ControlCandidate,
  candidate: ControlCandidate,
  matchOn: readonly MatchKey[],
): boolean {
  if (candidate.code === subject.code) return false;
  for (const key of matchOn) {
    if (candidate[key] !== subject[key]) return false;
  }
  return true;
}

const byCode = (a: ControlCandidate, b: ControlCandidate): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/**
 * Up to `k` matched controls, deterministic for (scope, pool). The result is sorted by code. Fewer than `k` come back
 * when fewer are eligible; none is not an error (the caller counts the setup as unmatched).
 */
export function matchControls(input: {
  subject: ControlCandidate;
  pool: readonly ControlCandidate[];
  matchOn: readonly MatchKey[];
  k: number;
  scope: string;
  masterSeed?: bigint;
}): ControlCandidate[] {
  const { subject, pool, matchOn, k, scope } = input;
  if (!Number.isInteger(k) || k < 0) throw new RangeError("k must be a non-negative integer");
  const seen = new Set<string>();
  const eligible = pool
    .filter((c) => matches(subject, c, matchOn))
    .filter((c) => {
      if (seen.has(c.code)) return false;
      seen.add(c.code);
      return true;
    })
    .sort(byCode);
  if (eligible.length <= k) return eligible;
  const rng = scopedPrng(scope, input.masterSeed ?? STATS_MASTER_SEED);
  const items = eligible.slice();
  for (let i = 0; i < k; i += 1) {
    const j = i + belowInt(rng, items.length - i);
    const t = items[i]!;
    items[i] = items[j]!;
    items[j] = t;
  }
  return items.slice(0, k).sort(byCode);
}
