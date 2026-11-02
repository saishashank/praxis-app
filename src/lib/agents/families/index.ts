// A5 family rule interpreter entry point (M4 T7; design 4.3). `runFamilies` is the single function
// the nightly 2b batch (live) and the replay engine both call (AGT-003): the same facts give the
// same output, byte for byte. No clock, no random source, no I/O; every iteration is sorted.
// Exits and stop recomputation for open trades are `evaluatePositions` (exits.ts).
import type { AgentParams } from "../params";
import { FAMILY_ORDER } from "./constants";
import { createContext } from "./context";
import { exceedsStopCap, STOP_DISTANCE_REASON } from "./stopCap";
import {
  componentsByCode,
  evaluateF1,
  evaluateF2,
  evaluateF3,
  evaluateF4,
  evaluateF5,
  evaluateF6,
  splitEvaluated,
  type Evaluated,
} from "./rules";
import type {
  BlockedCandidate,
  BlockedData,
  Candidate,
  Family,
  FamilyInputs,
  FamilyOptions,
  FamilyOutput,
} from "./types";

export * from "./types";
export * from "./constants";
export {
  evaluateExit,
  evaluatePositions,
  initialStop,
  gapCancelLevel,
  gapCancelsAtFill,
} from "./exits";
export { rsiUsable } from "./rules";
export { buildCodeFacts, indicatorParamsFrom, eventFactFromRow } from "./facts";

/** F2 fundamentals conditions that cannot be evaluated at $0 (FAM-102, decision 15). */
export const F2_BLOCKED_DATA: BlockedData = {
  family: "F2",
  status: "BLOCKED-DATA",
  conditions: [
    "positive_trailing_earnings",
    "pe_below_gics_sector_median",
    "net_debt_ebitda_below_2",
  ],
  note: "no point-in-time fundamentals or GICS sector source at $0 (DAT-170); F2 runs as F2-no-fundamentals",
};

/**
 * All families for session D. Families run in a fixed order (F1..F5, then F6 from their
 * unblocked signals). `candidates` are entries; `blocked` met the entry rules but a gate or filter
 * stopped them; both are sorted by rank, then higher ADV, then code ascending (FAM-001).
 */
export function runFamilies(
  inputs: FamilyInputs,
  params: AgentParams,
  opts: FamilyOptions = {},
): FamilyOutput {
  const ctx = createContext(inputs, params, opts);
  const evaluated: Record<Family, Evaluated[]> = { F1: [], F2: [], F3: [], F4: [], F5: [], F6: [] };
  evaluated.F1 = evaluateF1(ctx);
  evaluated.F2 = evaluateF2(ctx);
  evaluated.F3 = evaluateF3(ctx);
  evaluated.F4 = evaluateF4(ctx);
  evaluated.F5 = evaluateF5(ctx);
  evaluated.F6 = evaluateF6(
    ctx,
    componentsByCode([
      ...evaluated.F1,
      ...evaluated.F2,
      ...evaluated.F3,
      ...evaluated.F4,
      ...evaluated.F5,
    ]),
  );

  // FAM-004 (D-216): after F6, a candidate whose stop is further than the cap from the D close is blocked
  const closeOf = new Map(inputs.codes.map((f) => [f.code, f.bar.close] as const));
  for (const family of FAMILY_ORDER) {
    evaluated[family] = evaluated[family].map((e) => {
      if (e.reasons.length > 0) return e;
      const ref = closeOf.get(e.cand.code);
      if (ref === undefined || ref <= 0n) return e;
      return exceedsStopCap(e.cand, ref, params.entry.maxStopDistance)
        ? { cand: e.cand, reasons: [STOP_DISTANCE_REASON] }
        : e;
    });
  }

  const wanted = opts.families ?? FAMILY_ORDER;
  const candidates: Candidate[] = [];
  const blocked: BlockedCandidate[] = [];
  for (const family of FAMILY_ORDER) {
    if (!wanted.includes(family)) continue;
    const s = splitEvaluated(evaluated[family]);
    candidates.push(...s.candidates);
    blocked.push(...s.blocked);
  }
  return {
    d: inputs.d,
    candidates,
    blocked,
    blockedData: wanted.includes("F2") ? [F2_BLOCKED_DATA] : [],
  };
}

// ---- canonical JSON (rules_json / determinism checks) ----

function plain(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Set) return [...v].sort().map(plain);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.num === "bigint" && typeof o.den === "bigint") return `${o.num}/${o.den}`;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, plain(o[k])]),
    );
  }
  return v;
}

/** Key-sorted JSON (bigint as text, rationals as "num/den"): byte-identical for equal outputs. */
export function familyOutputJson(out: unknown): string {
  return JSON.stringify(plain(out));
}
