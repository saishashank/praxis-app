// Evaluation context shared by the family rules (M4 T7): session arithmetic, events indexed by
// code and group, tier return percentiles, rank ordering and rule-trace helpers. Pure.
import { cmpRat, makeRational, type Rational } from "@/lib/money/rational";
import { ratFromNumber, type AgentParams } from "../params";
import { tierPercentile } from "../indicators";
import { ARN011_V1, SPEC_CONSTANTS_V1 } from "./constants";
import type {
  Arn011Thresholds,
  Candidate,
  CodeFacts,
  EventFact,
  FamilyInputs,
  FamilyOptions,
  RuleTrace,
  SpecConstants,
  Tier,
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
  /** Codes sorted ascending (determinism). */
  readonly codes: readonly CodeFacts[];
  readonly groupsByCode: ReadonlyMap<string, readonly EventGroupFact[]>;
  /** 6-month return percentile within the code's tier; null = not computable. */
  readonly returnPercentile: ReadonlyMap<string, Rational | null>;
  sessionsAgo(day: string): number | null;
};

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

  // tier percentiles of the 6-month return (AGT-030): ties count half, self excluded
  const returnPercentile = new Map<string, Rational | null>();
  const tiers = new Map<Tier, CodeFacts[]>();
  for (const c of codes) {
    const list = tiers.get(c.tier);
    if (list === undefined) tiers.set(c.tier, [c]);
    else list.push(c);
  }
  for (const list of tiers.values()) {
    for (const c of list) {
      const self = c.ind.returnLookback;
      if (self === null) {
        returnPercentile.set(c.code, null);
        continue;
      }
      const others: Rational[] = [];
      for (const o of list) {
        if (o.code !== c.code && o.ind.returnLookback !== null) others.push(o.ind.returnLookback);
      }
      returnPercentile.set(c.code, tierPercentile(self, others));
    }
  }

  return {
    inputs,
    p,
    arn011: opts.arn011 ?? ARN011_V1,
    constants: opts.constants ?? SPEC_CONSTANTS_V1,
    u2OptInF1: opts.u2OptInF1 === true,
    restrictToU1: opts.restrictToU1 === true,
    f6Disabled: new Set(opts.f6DisabledClasses ?? []),
    codes,
    groupsByCode,
    returnPercentile,
    sessionsAgo,
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
