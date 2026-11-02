// Evaluation context shared by the family rules (M4 T7): session arithmetic, events indexed by
// code and group, tier return percentiles, rank ordering and rule-trace helpers. Pure.
import { cmpRat, makeRational, type Rational } from "@/lib/money/rational";
import { ratFromNumber, type AgentParams } from "../params";
import { lookbackReturn, tierPercentile } from "../indicators";
import { rankScores, type RankVariant } from "./rankScore";
import type {
  Arn011Thresholds,
  Candidate,
  CodeFacts,
  EventFact,
  FamilyInputs,
  FamilyOptions,
  IndexChangeFact,
  RuleTrace,
  SpecConstants,
  Tier,
  Family,
} from "./types";

/** One event group: all announcements of a code with the same day 0 (one event counts once). */
export type EventGroupFact = {
  readonly key: string;
  readonly code: string;
  readonly day0: string;
  /** Sessions between day 0 and D (0 = day 0 is D). */
  readonly sessionsAgo: number;
  readonly members: readonly EventFact[];
  readonly ar: Rational | null;
  readonly volRatio: Rational | null;
  readonly day0LowMicro: bigint | null;
};

export type EvalContext = {
  readonly inputs: FamilyInputs;
  readonly p: AgentParams;
  readonly arn011: Arn011Thresholds;
  readonly constants: SpecConstants;
  readonly u2OptInF1: boolean;
  readonly restrictToU1: boolean;
  /** F6 evidence classes treated as unavailable (ARN-076 leave-one-class-out; empty live). */
  readonly f6Disabled: ReadonlySet<string>;
  /** F4 event filter switched off (ARN-076 weekly with/without; false live). */
  readonly f4EventFilterOff?: boolean;
  /** O-49: also emit F5 on U3 as the descriptive `F5-U3-stress` variant (replay only). */
  readonly f5StressU3: boolean;
  /** Rule-version id stamped on each family's candidates (default: the v1 id, M6 T8). */
  readonly ruleVersions: Readonly<Partial<Record<Family, string>>>;
  /** Codes sorted ascending (determinism). */
  readonly codes: readonly CodeFacts[];
  readonly groupsByCode: ReadonlyMap<string, readonly EventGroupFact[]>;
  /** 6-month return percentile within the code's tier; null = not computable. */
  readonly returnPercentile: ReadonlyMap<string, Rational | null>;
  /**
   * F1's relative-strength percentile (KB-081): the same map as `returnPercentile` under the v1
   * settings, a recomputed one when `f1_return_window_sessions` or `f1_momentum_variant` differ.
   */
  readonly f1Percentile: ReadonlyMap<string, Rational | null>;
  sessionsAgo(day: string): number | null;
  /**
   * KB-081 rank variants: the rank-key value of `code` under a non-v1 variant from `rankScores`
   * (null = not scored). Memoised per (family, variant).
   */
  variantRank(family: Family, variant: RankVariant, code: string): Rational | null;
  /**
   * DAT-234 (D-238): an index add or delete of `code` whose announcement or effective date lies
   * within `index_change_window_sessions` of `day0` and that was known by D, else null.
   */
  indexChangeNear(code: string, day0: string): IndexChangeFact | null;
};

/** Sessions skipped by the F1 `skip_month_u2` momentum variant (one month). */
export const SKIP_MONTH_SESSIONS = 21; // threshold-ok: KB-081 skip-month convention (about one month)
const MS_PER_DAY = 86_400_000; // threshold-ok: milliseconds per day

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function firstDefined<T>(items: readonly (T | null)[]): T | null {
  for (const i of items) if (i !== null) return i;
  return null;
}

export function createContext(
  inputs: FamilyInputs,
  p: AgentParams,
  opts: FamilyOptions = {},
): EvalContext {
  const index = new Map<string, number>();
  inputs.sessions.forEach((s, i) => index.set(s, i));
  const dIdx = index.get(inputs.d);
  if (dIdx === undefined) throw new RangeError("sessions must end with D");
  const sessionsAgo = (day: string): number | null => {
    const i = index.get(day);
    return i === undefined ? null : dIdx - i;
  };

  const codes = [...inputs.codes].sort((a, b) => cmpStr(a.code, b.code));

  // events by code, then grouped by (code, day 0), all in a fixed order
  const byCode = new Map<string, EventFact[]>();
  const sortedEvents = [...inputs.events].sort(
    (a, b) => cmpStr(a.day0, b.day0) || cmpStr(a.id, b.id),
  );
  for (const e of sortedEvents) {
    if (e.day0 > inputs.d) continue;
    const list = byCode.get(e.code);
    if (list === undefined) byCode.set(e.code, [e]);
    else list.push(e);
  }
  const groupsByCode = new Map<string, EventGroupFact[]>();
  for (const [code, list] of byCode) {
    const byKey = new Map<string, EventFact[]>();
    for (const e of list) {
      const g = byKey.get(e.groupKey);
      if (g === undefined) byKey.set(e.groupKey, [e]);
      else g.push(e);
    }
    const groups: EventGroupFact[] = [];
    for (const key of [...byKey.keys()].sort()) {
      const members = byKey.get(key)!;
      const ago = sessionsAgo(members[0]!.day0);
      if (ago === null) continue; // a day 0 outside the supplied session list cannot be placed
      groups.push({
        key,
        code,
        day0: members[0]!.day0,
        sessionsAgo: ago,
        members,
        ar: firstDefined(members.map((m) => m.ar)),
        volRatio: firstDefined(members.map((m) => m.volRatio)),
        day0LowMicro: firstDefined(members.map((m) => m.day0LowMicro)),
      });
    }
    groupsByCode.set(code, groups);
  }

  // tier percentiles of a per-code return (AGT-030): ties count half, self excluded
  const percentiles = (selfOf: (c: CodeFacts) => Rational | null): Map<string, Rational | null> => {
    const out = new Map<string, Rational | null>();
    const tiers = new Map<Tier, CodeFacts[]>();
    for (const c of codes) {
      const list = tiers.get(c.tier);
      if (list === undefined) tiers.set(c.tier, [c]);
      else list.push(c);
    }
    for (const list of tiers.values()) {
      for (const c of list) {
        const self = selfOf(c);
        if (self === null) {
          out.set(c.code, null);
          continue;
        }
        const others: Rational[] = [];
        for (const o of list) {
          if (o.code === c.code) continue;
          const v = selfOf(o);
          if (v !== null) others.push(v);
        }
        out.set(c.code, tierPercentile(self, others));
      }
    }
    return out;
  };
  const returnPercentile = percentiles((c) => c.ind.returnLookback);
  // KB-081: the F1 variants read another window / skip the last month; v1 settings reuse the map above
  const f1Skip = p.f1.momentumVariant === "skip_month_u2";
  const f1Percentile =
    !f1Skip && p.f1.returnWindowSessions === p.windows.returnWindow
      ? returnPercentile
      : percentiles((c) =>
          lookbackReturn(
            f1Skip
              ? c.closesAdj.slice(0, Math.max(0, c.closesAdj.length - SKIP_MONTH_SESSIONS))
              : c.closesAdj,
            p.f1.returnWindowSessions,
          ),
        );

  // DAT-234: position of a date on the session line (dates after D count weekdays past D)
  const pos = (day: string): number => {
    const list = inputs.sessions;
    if (day <= inputs.d) {
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! <= day) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    let n = list.length;
    let t = Date.parse(`${inputs.d}T00:00:00Z`);
    const end = Date.parse(`${day}T00:00:00Z`);
    while (t < end) {
      t += MS_PER_DAY;
      const dow = new Date(t).getUTCDay();
      if (dow !== 0 && dow !== 6) n += 1; // threshold-ok: JS weekday numbers (Sunday 0, Saturday 6)
    }
    return n;
  };
  const indexWindow = p.entry.indexChangeWindowSessions;
  const indexChangeNear = (code: string, day0: string): IndexChangeFact | null => {
    const list = codes.find((c) => c.code === code)?.indexChanges;
    if (list === undefined || list.length === 0) return null;
    const at = pos(day0);
    for (const ch of list) {
      // neither announced nor effective by D: not yet known, so replay = live
      if ((ch.announced ?? ch.effective) > inputs.d) continue;
      const dates = ch.announced === null ? [ch.effective] : [ch.announced, ch.effective];
      if (dates.some((x) => Math.abs(pos(x) - at) <= indexWindow)) return ch;
    }
    return null;
  };

  const scoreCache = new Map<string, ReadonlyMap<string, Rational>>();
  const variantRank = (family: Family, variant: RankVariant, code: string): Rational | null => {
    const key = `${family}|${variant}`;
    let m = scoreCache.get(key);
    if (m === undefined) {
      m = new Map(rankScores(family, inputs, p, variant).map((r) => [r.code, floatRat(r.score)]));
      scoreCache.set(key, m);
    }
    return m.get(code) ?? null;
  };

  return {
    inputs,
    p,
    arn011: opts.arn011 ?? p.arn011,
    constants: opts.constants ?? p.specConstants,
    u2OptInF1: opts.u2OptInF1 === true,
    restrictToU1: opts.restrictToU1 === true,
    f6Disabled: new Set(opts.f6DisabledClasses ?? []),
    f4EventFilterOff: opts.f4EventFilterOff === true,
    f5StressU3: opts.f5StressU3 === true,
    ruleVersions: opts.ruleVersions ?? {},
    codes,
    groupsByCode,
    returnPercentile,
    f1Percentile,
    sessionsAgo,
    variantRank,
    indexChangeNear,
  };
}

// ---- text and traces ----

export const ratText = (r: Rational): string => `${r.num}/${r.den}`;
export const ratOrNull = (r: Rational | null): string => (r === null ? "null" : ratText(r));

export function trace(id: string, pass: boolean, value: string, threshold: string): RuleTrace {
  return { id, pass, value, threshold };
}

/** Float64 indicator value as an exact rational (through its shortest decimal text). */
export function floatRat(x: number): Rational {
  return ratFromNumber(x);
}

export function ratFromBig(n: bigint, d: bigint): Rational {
  return makeRational(n, d);
}

/** `a >= b` for a possibly-null left side (null fails). */
export function geq(a: Rational | null, b: Rational): boolean {
  return a !== null && cmpRat(a, b) >= 0;
}

// ---- ordering ----

function cmpRank(a: readonly (Rational | null)[], b: readonly (Rational | null)[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === null && y === null) continue;
    if (x === null) return 1; // unknown sorts last
    if (y === null) return -1;
    const c = cmpRat(y, x); // higher first
    if (c !== 0) return c;
  }
  return 0;
}

/** Rank descending, then higher ADV (FAM-001), then code ascending. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const r = cmpRank(a.rank, b.rank);
  if (r !== 0) return r;
  if (a.adv !== null || b.adv !== null) {
    if (a.adv === null) return 1;
    if (b.adv === null) return -1;
    const c = cmpRat(b.adv, a.adv);
    if (c !== 0) return c;
  }
  return cmpStr(a.code, b.code) || cmpStr(a.variant, b.variant);
}

export function rankText(rank: readonly (Rational | null)[]): string {
  return rank.map((r) => (r === null ? "unknown" : ratText(r))).join("|");
}
