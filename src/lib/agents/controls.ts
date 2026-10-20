// C2 / C3 matched random-entry selection (ARN-004; docs/M4_design.md 4.4 step 6, decision 33).
// For every entry an E-execution of family f takes on D, each live C2-f / C3-f cohort draws ONE
// control code with its own seeded PRNG (`c2:<cohort>:<d>`) from the pool "same tier, same
// 20-session volatility decile" (deciles of vol20 over that tier's eligible codes on D), passing
// the same filters and excluding the signal's code and every code with a same-day qualifying signal
// or event for f. A control that holds the drawn code, has no free slot or cannot afford the parcel
// SKIPS (recorded, never silently dropped). The control's exits are the family's exit rules mapped
// by M3 `mapControlExits` semantics: ATR-multiple stops rebuilt from the control's own ATR, the
// family's indicator and time rules unchanged, event-dependent rules replaced by the time stop.
// Pure functions only; the database side lives in batch2b.ts.
import { FAMILY_TIME_STOP_SESSIONS, type FamilyId } from "@/lib/arena/cohort";
import { makeRational, type Rational } from "@/lib/money/rational";
import type { CodeFacts, CsRule, ExitPlan, InitialStopRule, TrailRule } from "./families/types";
import type { Candidate } from "./families/types";
import type { OrderPlan, RelativeCs } from "./orderPlan";

const DECILES = 10; // threshold-ok: ARN-004 "same 20-session volatility decile"

/** vol decile (0..9) of every code of one tier: rank in (vol20, code) order x 10 / n. */
export function volDeciles(vol: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...vol.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  const out = new Map<string, number>();
  const n = sorted.length;
  sorted.forEach(([code], i) => out.set(code, Math.floor((DECILES * i) / n))); // money-float-ok: decile index of a float volatility rank, not money
  return out;
}

export type PoolInput = {
  /** The matched signal's code and tier. */
  readonly code: string;
  readonly tier: string;
  /** vol20 by code for the universe on D, and the tier of each code. */
  readonly vol20: ReadonlyMap<string, number>;
  readonly tierOf: ReadonlyMap<string, string>;
  /** Codes that cannot be controls: same-day qualifying signal or event for the family, halted, ... */
  readonly excluded: ReadonlySet<string>;
  /** Extra filter (gate, ATR warm, ARN-011): true = the code may be drawn. */
  readonly passes: (code: string) => boolean;
};

/** The sorted pool of drawable codes for one matched signal ([] when the signal has no decile). */
export function controlPool(input: PoolInput): string[] {
  const tierVol = new Map<string, number>();
  for (const [code, v] of input.vol20) {
    if (input.tierOf.get(code) === input.tier) tierVol.set(code, v);
  }
  const deciles = volDeciles(tierVol);
  const own = deciles.get(input.code);
  if (own === undefined) return [];
  const pool: string[] = [];
  for (const [code, decile] of deciles) {
    if (decile !== own || code === input.code || input.excluded.has(code)) continue;
    if (input.passes(code)) pool.push(code);
  }
  return pool.sort();
}

const sameRule = (a: CsRule, b: CsRule): boolean =>
  a.kind === "time_stop" &&
  b.kind === "time_stop" &&
  a.sessions === b.sessions &&
  a.minReturn === null &&
  b.minReturn === null;

export type ControlPlanInput = {
  readonly family: FamilyId;
  /** The matched signal's candidate, in D terms. */
  readonly matched: Candidate;
  readonly signalFacts: CodeFacts;
  readonly controlFacts: CodeFacts;
};

/**
 * The control's order plan (before the caller sets `caThrough` and rescales prices to the fill
 * session), or a skip reason. Event-anchored levels become ATR multiples measured on the matched
 * signal (distance from its close to the level, in its ATR) and are rebuilt from the control's own
 * ATR at ITS fill (TST101-042 semantics: no tick snap).
 */
export function controlPlan(input: ControlPlanInput): OrderPlan | { readonly skip: string } {
  const ctrlAtr = input.controlFacts.ind.atrWarm ? input.controlFacts.ind.atrMicro : null;
  if (ctrlAtr === null || ctrlAtr <= 0n) return { skip: "no_atr" };
  const sigAtr = input.signalFacts.ind.atrWarm ? input.signalFacts.ind.atrMicro : null;
  const sigClose = input.signalFacts.bar.close;
  const multiple = (level: bigint): Rational | null => {
    if (sigAtr === null || sigAtr <= 0n) return null;
    const distance = sigClose > level ? sigClose - level : 0n;
    return makeRational(distance, sigAtr);
  };
  const own = input.matched.plan;
  const stops: InitialStopRule[] = [];
  for (const rule of own.initialStops) {
    if (rule.via !== null) continue; // contributing families' stops are not the control's
    const s = rule.spec;
    let k: Rational | null = s.k;
    if (k === null && s.level_micro !== null) k = multiple(s.level_micro);
    if (k === null) return { skip: "unmappable" };
    stops.push({
      id: rule.id,
      via: null,
      spec: { atr_micro: ctrlAtr, k, cap: s.cap, level_micro: null },
    });
  }
  if (stops.length === 0) return { skip: "unmappable" };
  const trails: TrailRule[] = own.trails.filter((t) => t.via === null);
  const cs: CsRule[] = [];
  const rel: RelativeCs[] = [];
  const timeStop = FAMILY_TIME_STOP_SESSIONS[input.family];
  const push = (rule: CsRule): void => {
    if (!cs.some((x) => sameRule(x, rule))) cs.push(rule);
  };
  for (const rule of own.cs) {
    if (rule.via !== null) continue;
    if (rule.kind === "negative_event") {
      push({
        id: `${rule.id}->time`,
        via: null,
        kind: "time_stop",
        sessions: timeStop,
        minReturn: null,
      });
    } else if (rule.kind === "close_below_level") {
      const k = multiple(rule.levelMicro);
      if (k === null) {
        push({
          id: `${rule.id}->time`,
          via: null,
          kind: "time_stop",
          sessions: timeStop,
          minReturn: null,
        });
      } else {
        rel.push({ id: rule.id, k, atrMicro: ctrlAtr });
      }
    } else {
      push(rule);
    }
  }
  const plan: ExitPlan = { initialStops: stops, trails, cs };
  return {
    family: input.family,
    variant: input.matched.variant,
    ruleVersion: input.matched.ruleVersion,
    caThrough: "",
    caApplied: [],
    plan,
    rel,
  };
}

// ---- arena_control: the Owner pause and the kill-switch trip (D-094) ---------------------------------

export type ControlState = "enabled" | "paused" | "killed";
export type ControlRow = {
  readonly scope: string;
  readonly scopeKey: string;
  readonly state: string;
};
export type ControlStates = ReadonlyMap<string, ControlState>;

/**
 * Current state per `scope|scope_key` from the append-only log (rows in id order): the latest row
 * wins, except that `killed` is sticky - only a later `enabled` row of the SAME scope lifts it, a
 * later `paused` does not.
 */
export function controlStates(rows: readonly ControlRow[]): ControlStates {
  const out = new Map<string, ControlState>();
  for (const r of rows) {
    if (r.state !== "enabled" && r.state !== "paused" && r.state !== "killed") continue;
    const key = `${r.scope}|${r.scopeKey}`;
    if (out.get(key) === "killed" && r.state === "paused") continue;
    out.set(key, r.state);
  }
  return out;
}

/**
 * The effective state of one cohort. A `killed` row at ANY scope that covers the cohort wins (the
 * kill switch is a safety stop: a narrower `enabled` row, e.g. an Owner resume of one strategy,
 * must never override a family or market kill; D-139). Otherwise the most specific scope with a row
 * wins (execution > family > market), so the Owner can still resume one strategy under a pause.
 */
export function effectiveControl(
  states: ControlStates,
  scopes: { readonly market: string; readonly family: string | null; readonly execution: string },
): ControlState {
  const exec = states.get(`execution|${scopes.execution}`);
  const fam = scopes.family === null ? undefined : states.get(`family|${scopes.family}`);
  const market = states.get(`market|${scopes.market}`);
  if (exec === "killed" || fam === "killed" || market === "killed") return "killed";
  return exec ?? fam ?? market ?? "enabled";
}

/** The not-taken / skip reason for a non-enabled state, or null. */
export const controlReason = (s: ControlState): string | null =>
  s === "enabled" ? null : `control_${s}`;
