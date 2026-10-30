// Cold start (M15 C3b; CTX-055; AT-56 fixture 9). Sessions 1..`coldStartSessions` after go-live:
// F1 and F4 only; no weight changes, no force-apply and no map refit except data-quality vetoes
// (the CTX-060 refit guard applies from session 21); any candidate with an undefined angle is
// ineligible ("warming up"); after session 20 an abstain rate above `abstainAlarmPct` raises an
// Owner item; the session-20 population-stability check compares the feature population with the
// offline baseline. The nightly parity test is P2's. Pure: the session number comes from the view's
// session list and the go-live date; the abstain rate and the populations come in as numbers.
import type { Family } from "@/lib/agents/schema";
import type { AsOfView } from "../pit/types";
import { DEFAULT_STATES_PARAMS, type StatesParams } from "./types";

export type ColdStartParams = Pick<
  StatesParams,
  "coldStartSessions" | "abstainAlarmPct" | "psiMax"
>;

export const COLD_START_FAMILIES: readonly Family[] = ["F1", "F4"];

export type ColdStartPhase = "cold" | "warm";

export type ColdStartState = {
  readonly phase: ColdStartPhase;
  /** 1-based session number since go-live; 0 before go-live. */
  readonly sessionNumber: number;
  readonly familiesAllowed: readonly Family[];
  /** Weight changes, force-apply and map refits are off in the cold phase (data-quality vetoes stay on). */
  readonly refitAllowed: boolean;
  readonly label: string;
  readonly reason: string;
};

export type ColdStartInput = {
  readonly goLiveD: string;
  /** Share of cash-holding books that abstained tonight (0..100); null = not computed. */
  readonly abstainRatePct?: number | null;
  /** Feature population shares, offline baseline and tonight, aligned buckets; null = not available. */
  readonly population?: {
    readonly baseline: readonly number[];
    readonly tonight: readonly number[];
  } | null;
};

/** 1-based session number of sessions[t] counted from `goLiveD` (0 when t is before go-live). */
export function sessionNumberAt(view: AsOfView, t: number, goLiveD: string): number {
  let n = 0;
  for (let i = 0; i <= t; i += 1) if (view.sessions[i]! >= goLiveD) n += 1;
  return n;
}

/** Population-stability index over aligned bucket shares (a share of 0 is floored at 1e-6). */
export function populationStabilityIndex(
  baseline: readonly number[],
  tonight: readonly number[],
): number {
  if (baseline.length !== tonight.length || baseline.length === 0) {
    throw new RangeError("population buckets must align and be non-empty");
  }
  const eps = 1e-6;
  let psi = 0;
  for (let i = 0; i < baseline.length; i += 1) {
    const b = Math.max(eps, baseline[i]!);
    const c = Math.max(eps, tonight[i]!);
    psi += (c - b) * Math.log(c / b);
  }
  return psi;
}

export type ColdStartCheck = {
  readonly state: ColdStartState;
  /** The candidate is "warming up" when any scored angle is undefined (every phase). */
  readonly eligible: boolean;
  /** Owner item: abstain rate above the alarm after the cold phase. */
  readonly abstainAlarm: boolean;
  /** Session-20 population-stability check: null = not due or no data; false = failed (PSI > max). */
  readonly populationStable: boolean | null;
  readonly psi: number | null;
};

/** The cold-start state at session t and the checks it carries (pure). */
export function coldStartAt(
  view: AsOfView,
  t: number,
  input: ColdStartInput,
  undefinedAngles: boolean,
  params: ColdStartParams = DEFAULT_STATES_PARAMS,
): ColdStartCheck {
  const n = sessionNumberAt(view, t, input.goLiveD);
  const cold = n >= 1 && n <= params.coldStartSessions;
  const state: ColdStartState =
    n === 0
      ? {
          phase: "cold",
          sessionNumber: 0,
          familiesAllowed: [],
          refitAllowed: false,
          label: "not yet live",
          reason: "before_go_live",
        }
      : cold
        ? {
            phase: "cold",
            sessionNumber: n,
            familiesAllowed: COLD_START_FAMILIES,
            refitAllowed: false,
            label: `warming up (session ${n} of ${params.coldStartSessions})`,
            reason: "cold_start",
          }
        : {
            phase: "warm",
            sessionNumber: n,
            familiesAllowed: ["F1", "F2", "F3", "F4", "F5", "F6"],
            refitAllowed: true,
            label: "live",
            reason: "warm",
          };
  const rate = input.abstainRatePct ?? null;
  const abstainAlarm = state.phase === "warm" && rate !== null && rate > params.abstainAlarmPct;
  let psi: number | null = null;
  let populationStable: boolean | null = null;
  if (n === params.coldStartSessions && input.population) {
    psi = populationStabilityIndex(input.population.baseline, input.population.tonight);
    populationStable = psi <= params.psiMax;
  }
  // D-324: a candidate with an undefined angle is "warming up" in every phase (before go-live, cold
  // and warm alike); the phase changes families and refits, never the eligibility rule.
  return { state, eligible: !undefinedAngles, abstainAlarm, populationStable, psi };
}

/** The abstain line for a candidate with an undefined angle (CTX-055, CTX-070 words). */
export const WARMING_UP_LABEL = "we do not have enough history on this company yet (warming up)";
