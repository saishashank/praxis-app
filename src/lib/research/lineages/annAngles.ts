// The announcement-angle calibration (M23 T2; CXA-004, D-1635, D-1690...D-1694). Pure and seeded: no database, no clock.
// The frozen plan is `docs/research/prereg/CXA-004.json`; every number below is a transcription of it and a test checks
// that the two agree. Order of work (D-1605): the sessions are counted from their dates alone. Below the floor the function
// returns "below sample" before the reader is called once, so no outcome is read and the one look stays unspent. At or above
// the floor, each key (an angle, or one of the three labels) is read for every session: the first 70 % of the sessions
// fix its sign (development), the rest give the statistic, the mean over the holdout sessions of the sign times the daily
// rank correlation of its value with the 20-session market-adjusted outcome. Its one-sided interval is a stationary block
// bootstrap (block 20); a key is PASS when Benjamini-Hochberg at q = 0.10 over the keys that reached a statistic rejects it
// and its holdout mean is above zero. Aggregates only: no code, no company, no text leaves this module.
import { percentile } from "@/lib/stats/bootstrap";
import { benjaminiHochberg } from "@/lib/stats/multiplicity";
import { spearman } from "@/lib/stats/rankIc";
import { scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";
import { meanStatistic, stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import type { EngineVerdict } from "../eventStudy";

/** The repo path of the frozen plan (the registry hash is the sha256 of this file's text). */
export const ANN_PLAN_PATH = "docs/research/prereg/CXA-004.json";
/** Distinct sessions of timed archive items needed before the one look (D-1635). */
export const ANN_SESSION_FLOOR = 252; // threshold-ok: D-1635 the spec's one calibration sample
/** The development share of the sessions, as the fraction 7/10 (integer arithmetic: no float rounding at the edge). */
export const ANN_DEV_NUM = 7; // threshold-ok: D-1635 first 70 % of the sessions
export const ANN_DEV_DEN = 10; // threshold-ok: D-1635 first 70 % of the sessions
/** Fewest codes with both a value and an outcome for a day to count. */
export const ANN_MIN_CODES = 10; // threshold-ok: D-1635 rank_ic_min_codes
export const ANN_BLOCK_SESSIONS = 20; // threshold-ok: D-1635 the outcome horizon is 20 sessions
export const ANN_REPLICATES = 2000; // threshold-ok: D-1635 bootstrap replicates
export const ANN_Q = 0.1; // threshold-ok: D-1635 Benjamini-Hochberg level
/** Labelled share of the holdout announcements the labels need (D-1635), as the fraction 7/10. */
export const ANN_LABEL_COVERAGE_NUM = 7; // threshold-ok: D-1635 label coverage 70 %
export const ANN_LABEL_COVERAGE_DEN = 10; // threshold-ok: D-1635 label coverage 70 %

export const ANN_METER_LINEAGE = "ann_angles";
export const ANN_LABELS_LINEAGE = "ann_labels";
/** The text labels evaluated together as one family (CTX-040). */
export const ANN_LABEL_KEYS: readonly string[] = ["guidance", "event_confirm", "tone"];

/** The registry lineage of one angle (D-1635). */
export const annAngleLineage = (angleId: string): string => `ann_angle_${angleId}`;

/** Sessions in development: the integer part of 0.7 times the count. */
export const developmentCount = (sessions: number): number =>
  Math.floor((sessions * ANN_DEV_NUM) / ANN_DEV_DEN);

/** True when labelled announcements are at least 70 % of the announcements (integer arithmetic). */
export const labelsCovered = (labelled: number, items: number): boolean =>
  items > 0 && labelled * ANN_LABEL_COVERAGE_DEN >= items * ANN_LABEL_COVERAGE_NUM;

/** One session's values and outcomes of one key, aligned by code; null when the key has nothing that day. */
export type DayReading = {
  readonly scores: readonly number[];
  readonly outcomes: readonly number[];
};
/** Reads one key on one session. Called only after the floor is met (D-1605). */
export type PanelReader = (key: string, d: string) => DayReading | null;

export type KeyResult = {
  readonly key: string;
  readonly verdict: EngineVerdict;
  readonly reason: string;
  readonly sign: 1 | -1 | 0;
  readonly devDays: number;
  readonly holdDays: number;
  readonly devMean: number | null;
  readonly holdMean: number | null;
  readonly lower: number | null;
  readonly p: number | null;
  readonly rejected: boolean;
};

export type FamilyResult =
  | {
      readonly status: "below_sample";
      readonly sessions: number;
      readonly floor: number;
      readonly reason: string;
    }
  | {
      readonly status: "looked";
      readonly sessions: number;
      readonly devSessions: number;
      readonly holdSessions: number;
      /** Keys that reached a statistic: the size of the Benjamini-Hochberg family. */
      readonly familySize: number;
      readonly results: readonly KeyResult[];
    };

export type AnnParams = {
  readonly floor?: number;
  readonly minCodes?: number;
  readonly block?: number;
  readonly replicates?: number;
  readonly q?: number;
  readonly masterSeed?: bigint;
};

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function dailyIcs(
  key: string,
  days: readonly string[],
  read: PanelReader,
  minCodes: number,
): { index: number[]; ic: number[] } {
  const index: number[] = [];
  const ic: number[] = [];
  days.forEach((d, i) => {
    const r = read(key, d);
    if (r === null || r.scores.length !== r.outcomes.length || r.scores.length < minCodes) return;
    const v = spearman(r.scores, r.outcomes);
    if (v === null) return;
    index.push(i);
    ic.push(v);
  });
  return { index, ic };
}

type Draft = Omit<KeyResult, "verdict" | "rejected">;

/**
 * The sessions (oldest first, distinct) and the keys: counts first, then, only when the floor is met, one statistic per key.
 * Never throws on data; a key whose statistic cannot be computed is INCONCLUSIVE and left out of the family.
 */
export function annFamilyLook(
  sessions: readonly string[],
  keys: readonly string[],
  read: PanelReader,
  p: AnnParams = {},
): FamilyResult {
  const floor = p.floor ?? ANN_SESSION_FLOOR;
  if (sessions.length < floor) {
    return {
      status: "below_sample",
      sessions: sessions.length,
      floor,
      reason: `${sessions.length} sessions, the floor is ${floor}`,
    };
  }
  const minCodes = p.minCodes ?? ANN_MIN_CODES;
  const block = p.block ?? ANN_BLOCK_SESSIONS;
  const reps = p.replicates ?? ANN_REPLICATES;
  const q = p.q ?? ANN_Q;
  const devN = developmentCount(sessions.length);
  const dev = sessions.slice(0, devN);
  const hold = sessions.slice(devN);
  const drafts: Draft[] = [];
  const pvals = new Map<string, number>();
  for (const key of keys) {
    const a = dailyIcs(key, dev, read, minCodes);
    const devMean = a.ic.length === 0 ? null : mean(a.ic);
    const none = { holdDays: 0, holdMean: null, lower: null, p: null };
    if (devMean === null || devMean === 0) {
      drafts.push({
        key,
        sign: 0,
        devDays: a.ic.length,
        devMean,
        ...none,
        reason: "the development sessions fix no sign",
      });
      continue;
    }
    const sign: 1 | -1 = devMean > 0 ? 1 : -1;
    const h = dailyIcs(key, hold, read, minCodes);
    if (h.ic.length === 0) {
      drafts.push({
        key,
        sign,
        devDays: a.ic.length,
        devMean,
        ...none,
        reason: "no holdout session has a defined correlation",
      });
      continue;
    }
    const values = h.ic.map((v) => v * sign);
    const rep = stationaryBlockBootstrap(
      { sessions: h.index, sessionCount: hold.length },
      meanStatistic(values),
      scopedPrng(`research:ann:${key}:boot`, p.masterSeed ?? STATS_MASTER_SEED),
      { expectedBlock: block, maxHold: block, replicates: reps },
    );
    let atOrBelow = 0;
    for (const v of rep.values) if (v <= 0) atOrBelow += 1;
    const pv = (1 + atOrBelow) / (rep.values.length + 1);
    const lower = percentile(rep.values, q);
    pvals.set(key, pv);
    drafts.push({
      key,
      sign,
      devDays: a.ic.length,
      devMean,
      holdDays: values.length,
      holdMean: mean(values),
      lower: Number.isFinite(lower) ? lower : null,
      p: pv,
      reason: "",
    });
  }
  const ordered = [...pvals.keys()];
  const bh =
    ordered.length === 0
      ? null
      : benjaminiHochberg(
          ordered.map((k) => pvals.get(k)!),
          q,
          "prds",
        );
  const rejected = new Set(ordered.filter((_, i) => bh!.rejected[i]));
  const results: KeyResult[] = drafts.map((r) => {
    if (r.p === null) return { ...r, verdict: "INCONCLUSIVE", rejected: false };
    const pass = rejected.has(r.key) && r.holdMean! > 0;
    return {
      ...r,
      rejected: rejected.has(r.key),
      verdict: pass ? "PASS" : "NULL",
      reason: pass
        ? "rejected under the false-discovery level, holdout mean above zero"
        : "not rejected under the false-discovery level",
    };
  });
  return {
    status: "looked",
    sessions: sessions.length,
    devSessions: dev.length,
    holdSessions: hold.length,
    familySize: ordered.length,
    results,
  };
}

const round6 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e6) / 1e6); // threshold-ok: 6 places kept in a stored aggregate

/** The aggregates stored with one key's look (numbers and words only). */
export function keyStats(
  r: KeyResult,
  f: Extract<FamilyResult, { status: "looked" }>,
): Record<string, number | string | null> {
  return {
    sessions: f.sessions,
    devSessions: f.devSessions,
    holdSessions: f.holdSessions,
    devDays: r.devDays,
    holdDays: r.holdDays,
    sign: r.sign,
    devMeanIc: round6(r.devMean),
    holdMeanIc: round6(r.holdMean),
    lower90: round6(r.lower),
    p: round6(r.p),
    familySize: f.familySize,
    rejected: r.rejected ? "yes" : "no",
    reason: r.reason,
  };
}

/** The one verdict of the labels family: PASS if any label is rejected, NULL if some reached a statistic, else INCONCLUSIVE. */
export function labelsVerdict(rs: readonly KeyResult[]): EngineVerdict {
  if (rs.some((r) => r.verdict === "PASS")) return "PASS";
  return rs.some((r) => r.verdict === "NULL") ? "NULL" : "INCONCLUSIVE";
}

/**
 * The date of the session that is `ceil(remaining / ratePerSession)` sessions after `d`, walking the calendar over weekdays
 * that are not in `closed`. Null when no rate is known or the walk would pass 20 years.
 */
export function projectDate(
  d: string,
  remaining: number,
  ratePerSession: number,
  closed: ReadonlySet<string>,
): string | null {
  if (!(ratePerSession > 0) || remaining <= 0) return null;
  const need = Math.ceil(remaining / ratePerSession);
  const day = new Date(`${d}T00:00:00Z`);
  let seen = 0;
  for (let i = 0; i < 7300; i += 1) {
    // threshold-ok: a 20-year bound on the walk, not a rule
    day.setUTCDate(day.getUTCDate() + 1);
    const w = day.getUTCDay();
    const s = day.toISOString().slice(0, 10);
    if (w === 0 || w === 6 || closed.has(s)) continue;
    seen += 1;
    if (seen >= need) return s;
  }
  return null;
}
