// Halt vs suspension state machine (M15 C3b; CTX-016; AT-56 fixture 8; D-272 mark policy fixed).
//
//   none ──not trading, halt notice (or none)──> halt ──reopen──> none (+ reopen-gap exit test)
//   halt ──> suspension when: a "suspension from quotation" notice, the run exceeds `haltMaxSessions`,
//            or >= `suspensionHaltCount` halted sessions in any `suspensionWindowSessions` across
//            separate halts (serial halts count cumulatively; one run of 5 is still a halt)
//   suspension ──`suspensionEndTradedSessions` consecutive traded sessions──> none
//
// A halt: no exit fills; the position is marked at the last trade before the halt (the D9 pass is
// the caller's L0: the view's last bar is that trade) for at most `haltMaxSessions`; on reopen it is
// re-scored at the open and exits at the reopen open when the gap from the pre-halt close is below
// -`maxLossPct`. A suspension: marked at the declining policy value on sessions the code does not
// trade (a trading session is marked at market), reported as a loss ("suspended since ..."), with an
// outcome class {reinstated, recapitalised, delisted, unknown}. A halt never busts a book by itself;
// a suspension's declining mark is a real loss and can.
//
// The classifier reads the view's halt flags per session (`halted(code, t')` for t' <= t) and the
// notice kind. The view's events carry a category (`halt_suspension`) but not the title, so the kind
// comes from `haltNoticeKind(type, title)` run by the producer, passed in as `notices` (session date
// -> kind); absent = classify by duration and count alone.
import type { AsOfView } from "../pit/types";
import { DEFAULT_STATES_PARAMS, type StatesParams, type StateRow, type StepOutcome } from "./types";

export type HaltParams = Pick<
  StatesParams,
  | "haltMaxSessions"
  | "suspensionWindowSessions"
  | "suspensionHaltCount"
  | "suspensionEndTradedSessions"
  | "suspensionMark"
  | "maxLossPct"
>;

export type HaltNoticeKind = "halt" | "suspension";

const SUSPENSION_RE = /\bsuspen(sion|ded)\b/i;
const HALT_RE = /\btrading halt\b/i;

/** The notice kind from an ASX announcement type and title (same words as events.ts rule "halt"). */
export function haltNoticeKind(type: string | null, title: string): HaltNoticeKind | null {
  const text = `${type ?? ""} ${title}`;
  if (SUSPENSION_RE.test(text)) return "suspension";
  if (HALT_RE.test(text)) return "halt";
  return null;
}

export type SuspensionOutcome = "reinstated" | "recapitalised" | "delisted" | "unknown";

export type HaltState =
  | { readonly state: "none" }
  | {
      readonly state: "halt";
      readonly sinceD: string;
      /** Raw close of the last trade before the halt; null when the code never traded. */
      readonly markMicro: bigint | null;
      readonly preHaltCloseMicro: bigint | null;
      /** Halted sessions in this run so far (the current one included). */
      readonly runSessions: number;
    }
  | {
      readonly state: "suspension";
      readonly sinceD: string;
      readonly lastTradeMicro: bigint | null;
      /** Sessions not traded since the suspension began (the current one included when not traded). */
      readonly untradedSessions: number;
      /** Consecutive traded sessions at the end of the run (ends the state at the limit). */
      readonly tradedRun: number;
      readonly outcome: SuspensionOutcome;
    };

export const HALT_NONE: HaltState = { state: "none" };

export type HaltEffects = {
  /** G08 `8c_halt_suspension`: no entries while halted or suspended. */
  readonly entriesBlocked: boolean;
  /** No exit fills this session (halted: nothing trades). */
  readonly exitFillsBlocked: boolean;
  /** NAV mark for the position this session; null = mark at market. */
  readonly markMicro: bigint | null;
  /** Declining policy percentage applied to the last trade (100 = none); null when not suspended. */
  readonly markPct: number | null;
  /** The reopen gap from the pre-halt close exceeded the loss budget: exit at the reopen open. */
  readonly reopenGapExit: boolean;
  /** "suspended since ..." the loss is reported against this date. */
  readonly suspendedSince: string | null;
  readonly outcome: SuspensionOutcome | null;
  /** D-323: the suspension ended in a delisting; book the position at this final policy value. */
  readonly delistExit: { readonly markMicro: bigint } | null;
};

export type HaltStep = StepOutcome<HaltState> & { readonly effects: HaltEffects };

const NO_EFFECTS: HaltEffects = {
  entriesBlocked: false,
  exitFillsBlocked: false,
  markMicro: null,
  markPct: null,
  reopenGapExit: false,
  suspendedSince: null,
  outcome: null,
  delistExit: null,
};

/**
 * The declining mark policy (CTX-016, D-272): 100 % for the first `fullSessions` untraded sessions,
 * then -`stepPts` per further `stepSessions`, never below `floorPct`. `untraded` is 1-based.
 */
export function suspensionMarkPct(
  untraded: number,
  policy: StatesParams["suspensionMark"] = DEFAULT_STATES_PARAMS.suspensionMark,
): number {
  if (!Number.isSafeInteger(untraded) || untraded < 1)
    throw new RangeError("untraded must be >= 1");
  if (untraded <= policy.fullSessions) return 100;
  const steps = Math.floor((untraded - policy.fullSessions - 1) / policy.stepSessions) + 1;
  return Math.max(policy.floorPct, 100 - steps * policy.stepPts);
}

/** last trade x pct / 100, rounded down (a mark never rounds up). */
export function markAtPct(lastTradeMicro: bigint, pct: number): bigint {
  return (lastTradeMicro * BigInt(pct)) / 100n;
}

function row(code: string, fromD: string, state: string, basis: Record<string, unknown>): StateRow {
  return { kind: "halt", code, fromD, state, basis, sourceRef: null };
}

/** Halted flags of the last `n` sessions up to t (oldest first); unknown reads as not halted. */
function haltedWindow(view: AsOfView, code: string, t: number, n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = Math.max(0, t - n + 1); i <= t; i += 1) out.push(view.halted(code, i) === true);
  return out;
}

/** The raw close of the last bar strictly before `d` known at t. */
function closeBefore(view: AsOfView, code: string, t: number, d: string): bigint | null {
  const bars = view.bars(code, t, 2);
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i]!.d < d) return bars[i]!.close;
  return null;
}

/** The outcome class from the actions and events known at t (delisting wins; a raising = recapitalised). */
/** Delisting reasons that book zero (ARN-026). */
const ZERO_VALUE_REASONS: readonly string[] = ["administration", "liquidation"];

/** The delisting record of this suspension whose ex-date is on or before `d`, if any. */
function delistingAt(view: AsOfView, code: string, t: number, sinceD: string, d: string) {
  return (
    view
      .corpActions(code, t)
      .find((a) => a.type === "delisting" && a.exDate >= sinceD && a.exDate <= d) ?? null
  );
}

function outcomeAt(view: AsOfView, code: string, t: number, sinceD: string): SuspensionOutcome {
  if (view.corpActions(code, t).some((a) => a.type === "delisting" && a.exDate >= sinceD))
    return "delisted";
  if (view.events(code, t).some((e) => e.category === "capital_raising" && e.day0 >= sinceD)) {
    return "recapitalised";
  }
  return "unknown";
}

export type HaltStepInput = {
  /** Notice kind by session date (from `haltNoticeKind` on the day's announcements); absent = none. */
  readonly notices?: ReadonlyMap<string, HaltNoticeKind>;
};

/** One session of the machine; pure over the view at t. */
export function stepHalt(
  view: AsOfView,
  code: string,
  t: number,
  prev: HaltState | null,
  params: HaltParams = DEFAULT_STATES_PARAMS,
  input: HaltStepInput = {},
): HaltStep {
  const d = view.sessions[t]!;
  const s = prev ?? HALT_NONE;
  const haltedNow = view.halted(code, t) === true;
  const notice = input.notices?.get(d) ?? null;
  const window = haltedWindow(view, code, t, params.suspensionWindowSessions);
  const haltedInWindow = window.filter(Boolean).length;
  /** Serial halts count cumulatively: the window holds halted sessions beyond the current run. */
  const serial = (run: number): boolean =>
    haltedInWindow >= params.suspensionHaltCount && haltedInWindow > run;

  if (s.state === "suspension") {
    // D-324: an unknown halt flag reads as untraded (fail closed; the traded run does not grow).
    const traded = view.halted(code, t) === false;
    const tradedRun = traded ? s.tradedRun + 1 : 0;
    const untraded = traded ? s.untradedSessions : s.untradedSessions + 1;
    const outcome = outcomeAt(view, code, t, s.sinceD);
    // D-323: a delisting ends the suspension on the first session at or after its ex-date; the
    // position is booked at the final policy value (zero for administration / liquidation, ARN-026).
    const delisting = delistingAt(view, code, t, s.sinceD, d);
    if (delisting !== null) {
      const pct = suspensionMarkPct(Math.max(1, untraded), params.suspensionMark);
      const zero = ZERO_VALUE_REASONS.includes(String(delisting.payload.reason ?? ""));
      const markMicro = s.lastTradeMicro === null || zero ? 0n : markAtPct(s.lastTradeMicro, pct);
      return {
        next: HALT_NONE,
        label: `delisted while suspended since ${s.sinceD}: the position is booked at its final value`,
        reason: "suspension_delisted",
        row: row(code, d, "none", {
          after: "suspension",
          since: s.sinceD,
          outcome: "delisted",
          delistingId: delisting.id,
          markMicro: markMicro.toString(),
        }),
        effects: {
          ...NO_EFFECTS,
          entriesBlocked: true,
          exitFillsBlocked: true,
          suspendedSince: s.sinceD,
          outcome: "delisted",
          delistExit: { markMicro },
        },
      };
    }
    if (tradedRun >= params.suspensionEndTradedSessions) {
      const final: SuspensionOutcome = outcome === "unknown" ? "reinstated" : outcome;
      return {
        next: HALT_NONE,
        label: "trading has resumed for long enough: the suspension is over",
        reason: "suspension_ended",
        row: row(code, d, "none", { after: "suspension", since: s.sinceD, outcome: final }),
        effects: { ...NO_EFFECTS, outcome: final },
      };
    }
    const pct = traded ? null : suspensionMarkPct(untraded, params.suspensionMark);
    const next: HaltState = { ...s, untradedSessions: untraded, tradedRun, outcome };
    return {
      next,
      label: `suspended since ${s.sinceD}: marked down and counted as a loss`,
      reason: traded ? "suspension_traded_session" : "suspension_marked",
      row: null,
      effects: {
        ...NO_EFFECTS,
        entriesBlocked: true,
        exitFillsBlocked: !traded,
        markMicro:
          pct === null || s.lastTradeMicro === null ? null : markAtPct(s.lastTradeMicro, pct),
        markPct: pct,
        suspendedSince: s.sinceD,
        outcome,
      },
    };
  }

  if (s.state === "halt") {
    if (!haltedNow) {
      // Reopen: re-scored at the open; the gap from the pre-halt close against the loss budget.
      const bar = view.bars(code, t, 1)[0];
      const open = bar !== undefined && bar.d === d ? bar.open : null;
      let gapExit = false;
      if (open !== null && s.preHaltCloseMicro !== null && s.preHaltCloseMicro > 0n) {
        // open < pre x (1 - maxLoss/100)  <=>  open x 100 < pre x (100 - maxLoss)
        const scaled = BigInt(Math.round(params.maxLossPct * 1_000_000));
        gapExit = open * 100_000_000n < s.preHaltCloseMicro * (100_000_000n - scaled);
      }
      return {
        next: HALT_NONE,
        label: gapExit
          ? "the stock reopened far below where it halted: the position exits at the reopen"
          : "the trading halt is over",
        reason: gapExit ? "reopen_gap_exit" : "halt_reopened",
        row: row(code, d, "none", { after: "halt", since: s.sinceD, reopenGapExit: gapExit }),
        effects: { ...NO_EFFECTS, reopenGapExit: gapExit },
      };
    }
    const runSessions = s.runSessions + 1;
    const toSuspension =
      notice === "suspension" || runSessions > params.haltMaxSessions || serial(runSessions);
    if (toSuspension) {
      const next: HaltState = {
        state: "suspension",
        sinceD: d,
        lastTradeMicro: s.markMicro,
        untradedSessions: 1,
        tradedRun: 0,
        outcome: outcomeAt(view, code, t, d),
      };
      const pct = suspensionMarkPct(1, params.suspensionMark);
      return {
        next,
        label: `suspended since ${d}: marked down and counted as a loss`,
        reason:
          notice === "suspension"
            ? "suspension_notice"
            : runSessions > params.haltMaxSessions
              ? "halt_too_long"
              : "serial_halts",
        row: row(code, d, "suspension", {
          lastTradeMicro: s.markMicro?.toString() ?? null,
          haltSince: s.sinceD,
        }),
        effects: {
          ...NO_EFFECTS,
          entriesBlocked: true,
          exitFillsBlocked: true,
          markMicro: s.markMicro === null ? null : markAtPct(s.markMicro, pct),
          markPct: pct,
          suspendedSince: d,
          outcome: next.outcome,
        },
      };
    }
    const next: HaltState = { ...s, runSessions };
    return {
      next,
      label: "a trading halt is in the way",
      reason: "halted",
      row: null,
      effects: {
        ...NO_EFFECTS,
        entriesBlocked: true,
        exitFillsBlocked: true,
        markMicro: s.markMicro,
      },
    };
  }

  // none
  if (!haltedNow) {
    return {
      next: HALT_NONE,
      label: "trading normally",
      reason: "none",
      row: null,
      effects: NO_EFFECTS,
    };
  }
  // A delisted code stays flagged as not trading; it never re-enters a halt or suspension (D-323).
  if (delistingAt(view, code, t, "", d) !== null) {
    return {
      next: HALT_NONE,
      label: "this company has been delisted",
      reason: "delisted",
      row: null,
      effects: { ...NO_EFFECTS, entriesBlocked: true, exitFillsBlocked: true },
    };
  }
  const sinceD = view.haltSince(code, t) ?? d;
  const mark = closeBefore(view, code, t, sinceD);
  const runSessions = 1;
  if (notice === "suspension" || serial(runSessions)) {
    const next: HaltState = {
      state: "suspension",
      sinceD: d,
      lastTradeMicro: mark,
      untradedSessions: 1,
      tradedRun: 0,
      outcome: outcomeAt(view, code, t, d),
    };
    const pct = suspensionMarkPct(1, params.suspensionMark);
    return {
      next,
      label: `suspended since ${d}: marked down and counted as a loss`,
      reason: notice === "suspension" ? "suspension_notice" : "serial_halts",
      row: row(code, d, "suspension", { lastTradeMicro: mark?.toString() ?? null }),
      effects: {
        ...NO_EFFECTS,
        entriesBlocked: true,
        exitFillsBlocked: true,
        markMicro: mark === null ? null : markAtPct(mark, pct),
        markPct: pct,
        suspendedSince: d,
        outcome: next.outcome,
      },
    };
  }
  const next: HaltState = {
    state: "halt",
    sinceD,
    markMicro: mark,
    preHaltCloseMicro: mark,
    runSessions,
  };
  return {
    next,
    label: "a trading halt is in the way",
    reason: "halt_start",
    row: row(code, d, "halt", { since: sinceD, markMicro: mark?.toString() ?? null }),
    effects: { ...NO_EFFECTS, entriesBlocked: true, exitFillsBlocked: true, markMicro: mark },
  };
}

/** The state after folding every session 0..t (pure feature of the view). */
export function haltStateAt(
  view: AsOfView,
  code: string,
  t: number,
  params: HaltParams = DEFAULT_STATES_PARAMS,
  input: HaltStepInput = {},
): HaltStep {
  let s: HaltState | null = null;
  let last: HaltStep | null = null;
  for (let i = 0; i <= t; i += 1) {
    last = stepHalt(view, code, i, s, params, input);
    s = last.next;
  }
  return last!;
}
