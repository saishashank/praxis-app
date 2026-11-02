// M17 WP5: the gates of an intraday candidate (AGT-142), "as for a night pick". Pure: the caller
// (scan.ts) gathers plain facts; this composes the existing night gates (G01 L0 code, G02
// eligibility, G08 event and state, G11 portfolio) with the liquidity floor and the held check.
// The first failing gate stops the list; a failing candidate is recorded with that gate.
import { ADV_FLOOR_PER_PARCEL_MICRO } from "@/lib/cortex/economics/cost";
import {
  gateEligibility,
  gateEventState,
  gateL0Code,
  gatePortfolio,
  type EventStateInput,
  type GateResult,
  type PortfolioInput,
} from "@/lib/cortex/gates";
import { WARMING_UP_LABEL } from "@/lib/cortex/score/eligibility";

/** Structurally a `ViewBar` (declared here: the order-boundary guard allows no import from src/lib/agents). */
export type EodBar = {
  readonly d: string;
  readonly open: bigint;
  readonly high: bigint;
  readonly low: bigint;
  readonly close: bigint;
  readonly volume: bigint;
};

export const MIN_HISTORY_BARS = 61; // threshold-ok: 60 returns need 61 closes (AGT-141 sd60)

export type ScanGateInput = {
  /** Latest end-of-day bar before the session (micro); null = none. */
  bar: EodBar | null;
  barCount: number;
  eventState: EventStateInput;
  /** Average daily value traded, micro-AUD; null = unknown (fails the floor). */
  advMicro: bigint | null;
  heldAlready: boolean;
  /** Null = no arena NAV to cap against (no books yet). */
  portfolio: PortfolioInput | null;
};

export type ScanGateResult = { passed: string[]; failed: string | null };

const note = (r: GateResult): string =>
  r.pass ? "ok" : `${r.gateId}${r.value === undefined ? "" : `:${r.value}`}`;

export function scanGates(x: ScanGateInput): ScanGateResult {
  const passed: string[] = [];
  const step = (name: string, r: GateResult): boolean => {
    if (r.pass) {
      passed.push(name);
      return true;
    }
    return false;
  };
  const l0 = gateL0Code({
    bar: x.bar,
    adjClose: x.bar === null ? null : x.bar.close,
    vetoFlags: [],
  });
  if (!step("L0_code", l0)) return { passed, failed: note(l0) };
  const elig = gateEligibility(
    x.barCount >= MIN_HISTORY_BARS
      ? { eligible: true }
      : { eligible: false, reason: "warming_up", missing: ["history"], label: WARMING_UP_LABEL },
  );
  if (!step("eligibility", elig)) return { passed, failed: note(elig) };
  const ev = gateEventState(x.eventState);
  if (!step("event_state", ev)) return { passed, failed: note(ev) };
  if (x.advMicro === null || x.advMicro < ADV_FLOOR_PER_PARCEL_MICRO) {
    return { passed, failed: "liquidity_floor" };
  }
  passed.push("liquidity_floor");
  if (x.heldAlready) return { passed, failed: "already_held" };
  passed.push("not_held");
  if (x.portfolio !== null) {
    const pf = gatePortfolio(x.portfolio);
    if (!step("portfolio", pf)) return { passed, failed: note(pf) };
  }
  return { passed, failed: null };
}
