// Open-time checks O01…O07 (M15 C3c; spec ch. 17 CTX-028; docs/M15_design.md 3b "Open-time list").
// A second, separate list run at the 09:55 re-check and again at each code's fill. `preopenDecision`
// (arena/preopen.ts) keeps its own checks first (halt, quality, asx_query, placement, thesis-breaker);
// these Cortex checks follow, as pure functions of plain inputs, and stop at the first failure.
// Kills and the stop-plus-gap95 cap are re-checked at 09:55; if the re-check cannot run, pending
// buys are cancelled (O07, superseding v1's `not_rechecked` for Cortex-governed orders only).
import { initialStop } from "@/lib/agents/families/exits";
import type { Family, RegimeLabel, StopSpec } from "@/lib/agents/families/types";
import type { LimitFillOutcome } from "@/lib/arena/fills";
import type { Micro } from "@/lib/money/micro";
import type { Rational } from "@/lib/money/rational";
import { gapCapTest, stopDistanceRat } from "../economics/gapCap";
import type { InputKind } from "../pit/types";
import { OPEN_LABELS } from "./list";
import { OPEN_IDS, type OpenId, type OpenResult, type OpenTraceEntry } from "./types";

const opass = (value?: string): OpenResult =>
  value === undefined ? { pass: true } : { pass: true, value };
const ofail = (openId: OpenId, value?: string): OpenResult =>
  value === undefined
    ? { pass: false, openId, label: OPEN_LABELS[openId] }
    : { pass: false, openId, label: OPEN_LABELS[openId], value };

export type Kills = {
  readonly arena: boolean;
  readonly families: ReadonlySet<Family>;
  readonly sourcesOff: ReadonlySet<InputKind>;
};

/** O01: the Owner switch (whole arena) or the family kill (CTX-072). */
export function openKill(kills: Pick<Kills, "arena" | "families">, family: Family): OpenResult {
  if (kills.arena) return ofail("O01_kill", "arena");
  if (kills.families.has(family)) return ofail("O01_kill", family);
  return opass();
}

/** O02: a source the order's evidence read is off (DAT-127 style source gate). */
export function openSourceOff(
  sourcesOff: ReadonlySet<InputKind>,
  needed: readonly InputKind[],
): OpenResult {
  const off = [...needed].filter((k) => sourcesOff.has(k)).sort();
  if (off.length > 0) return ofail("O02_source_off", off.join(","));
  return opass();
}

/** O03: a SHOCK regime at the morning re-check blocks every pending buy except F4 (CTX-017 half size stands). */
export function openShockBlock(regime: RegimeLabel, family: Family): OpenResult {
  if (regime === "SHOCK" && family !== "F4") return ofail("O03_shock_block", regime);
  return opass(regime);
}

/** O04: share of universe codes without a fresh bar above `stale_universe_max_share`. */
export function openStaleUniverse(staleShare: number, maxShare: number): OpenResult {
  if (!(staleShare >= 0 && staleShare <= 1)) throw new RangeError("stale share must be in [0, 1]");
  if (!(maxShare >= 0 && maxShare <= 1)) throw new RangeError("stale_universe_max_share in [0, 1]");
  if (staleShare > maxShare) {
    return ofail("O04_stale_universe", `${staleShare.toFixed(4)} > ${maxShare.toFixed(4)}`);
  }
  return opass(staleShare.toFixed(4));
}

/**
 * O05: the limit formula at the fill — the order fills only at or below its limit (`fillEntryLimit`);
 * an open above the cap whose low never reaches the limit is `unfilled` in both arms (D-288).
 */
export function openGapCap(fill: LimitFillOutcome): OpenResult {
  if (fill.status === "unfilled") return ofail("O05_gap_cap", fill.reason);
  return opass(`${fill.fill.rule}:${fill.fill.fillPriceMicro}`);
}

export type StopGap95Input = {
  readonly fillMicro: Micro;
  readonly stopSpec: StopSpec;
  /** The matched cell's gap95 (fraction); undefined fails closed. */
  readonly gap95: number | undefined;
  readonly maxLoss: Rational;
};

/** O06: the stop referenced to the actual fill, plus gap95, within `max_loss_pct` (CTX-022b). */
export function openStopGap95(
  input: StopGap95Input,
): OpenResult & { readonly stopMicro: Micro | null } {
  if (input.gap95 === undefined)
    return { ...ofail("O06_stop_gap95", "gap95_unknown"), stopMicro: null };
  const stop = initialStop(input.stopSpec, input.fillMicro);
  if (stop <= 0n || stop >= input.fillMicro) {
    return { ...ofail("O06_stop_gap95", `stop:${stop}`), stopMicro: stop };
  }
  const r = gapCapTest({
    stopDistance: stopDistanceRat(input.fillMicro, stop),
    gap95: input.gap95,
    maxLoss: input.maxLoss,
  });
  const text = `${r.total.num}/${r.total.den} vs ${r.maxLoss.num}/${r.maxLoss.den}`;
  return r.pass
    ? { ...opass(text), stopMicro: stop }
    : { ...ofail("O06_stop_gap95", text), stopMicro: stop };
}

/** O07: the 09:55 re-check did not run → cancel (supersedes `not_rechecked` for Cortex orders). */
export function openRecheckMissing(rechecked: boolean): OpenResult {
  return rechecked ? opass() : ofail("O07_recheck_missing");
}

export type OpenChecksInput = {
  readonly family: Family;
  readonly kills: Kills;
  readonly sourcesNeeded: readonly InputKind[];
  readonly regime: RegimeLabel;
  readonly staleShare: number;
  readonly staleUniverseMaxShare: number;
  /** null at the 09:55 run (no fill yet): O05 and O06 are recorded as passes with value "preopen". */
  readonly fill: LimitFillOutcome | null;
  readonly stopSpec: StopSpec;
  readonly gap95: number | undefined;
  readonly maxLoss: Rational;
  readonly rechecked: boolean;
};

export type OpenChecks = {
  readonly trace: readonly OpenTraceEntry[];
  readonly firstFail: OpenId | null;
  /** The stop referenced to the fill when O06 ran on a fill. */
  readonly stopMicro: Micro | null;
};

/** The CTX-028 list in order, stopping at the first failure. */
export function openTimeChecks(input: OpenChecksInput): OpenChecks {
  const trace: OpenTraceEntry[] = [];
  let stopMicro: Micro | null = null;
  const step = (openId: OpenId, r: OpenResult): boolean => {
    trace.push({ ...r, openId });
    return r.pass;
  };
  for (const id of OPEN_IDS) {
    let r: OpenResult;
    switch (id) {
      case "O01_kill":
        r = openKill(input.kills, input.family);
        break;
      case "O02_source_off":
        r = openSourceOff(input.kills.sourcesOff, input.sourcesNeeded);
        break;
      case "O03_shock_block":
        r = openShockBlock(input.regime, input.family);
        break;
      case "O04_stale_universe":
        r = openStaleUniverse(input.staleShare, input.staleUniverseMaxShare);
        break;
      case "O05_gap_cap":
        r = input.fill === null ? opass("preopen") : openGapCap(input.fill);
        break;
      case "O06_stop_gap95": {
        if (input.fill === null || input.fill.status !== "filled") {
          r = opass("preopen");
          break;
        }
        const s = openStopGap95({
          fillMicro: input.fill.fill.fillPriceMicro,
          stopSpec: input.stopSpec,
          gap95: input.gap95,
          maxLoss: input.maxLoss,
        });
        stopMicro = s.stopMicro;
        r = s.pass ? opass(s.value) : s;
        break;
      }
      case "O07_recheck_missing":
        r = openRecheckMissing(input.rechecked);
        break;
    }
    if (!step(id, r)) return { trace, firstFail: id, stopMicro };
  }
  return { trace, firstFail: null, stopMicro };
}
