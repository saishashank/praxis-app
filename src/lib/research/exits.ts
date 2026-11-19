// Research engine, exits (M23 R1; D-1627). Pure. The default is the time exit: in at the open after the signal session,
// out at the open `hold` sessions later, no stop. A lineage that says so adds a stop at a fixed share below the entry:
// the first session whose low reaches it exits at the NEXT open (the app's fill model, D-1638). Sessions are integer
// indexes of one calendar; a missing price is an unfilled setup (`undefined`), never a guess.
import type { Micro } from "./costs";

/** Prices by code and session index, micro. `low` is needed only for a stop rule. */
export type PriceBook = {
  open(code: string, session: number): Micro | undefined;
  low?(code: string, session: number): Micro | undefined;
};

export type ExitRule =
  | { readonly kind: "time" }
  | {
      readonly kind: "stop";
      /** Share below the entry, parts per million. */
      readonly stopBelowPpm: number;
    };

export const TIME_EXIT: ExitRule = { kind: "time" };

export type ResolvedExit = {
  readonly session: number;
  readonly priceMicro: Micro;
  readonly reason: "time" | "stop";
};

const PPM = 1_000_000n; // threshold-ok: parts per million

/** The entry session of a signal session: the next one (entry at the next open). */
export function entrySessionOf(signalSession: number): number {
  return signalSession + 1;
}

/** The scheduled time-exit session of a position entered at `entrySession` and held `hold` sessions. */
export function timeExitSession(entrySession: number, hold: number): number {
  if (!Number.isInteger(hold) || hold < 1) throw new RangeError("hold must be a positive integer");
  return entrySession + hold;
}

/** The stop price of an entry: the entry less `stopBelowPpm` ppm of it, rounded down (exact). */
export function stopPriceMicro(entryMicro: Micro, stopBelowPpm: number): Micro {
  if (!Number.isInteger(stopBelowPpm) || stopBelowPpm < 0)
    throw new RangeError("stopBelowPpm must be a non-negative integer");
  return entryMicro - (entryMicro * BigInt(stopBelowPpm)) / PPM;
}

/**
 * Where and at what price a position exits. Time rule: the open at `entrySession + hold`. Stop rule: scan the sessions
 * from the entry session to the one before the scheduled exit; the first whose low is at or below the stop exits at the
 * following open; otherwise the scheduled open. Returns undefined when a price the path needs is missing.
 */
export function resolveExit(input: {
  rule: ExitRule;
  code: string;
  entrySession: number;
  hold: number;
  entryMicro: Micro;
  prices: PriceBook;
}): ResolvedExit | undefined {
  const { rule, code, entrySession, hold, entryMicro, prices } = input;
  const scheduled = timeExitSession(entrySession, hold);
  if (rule.kind === "stop") {
    if (prices.low === undefined) throw new RangeError("a stop rule needs a low price accessor");
    const stop = stopPriceMicro(entryMicro, rule.stopBelowPpm);
    for (let s = entrySession; s < scheduled; s += 1) {
      const low = prices.low(code, s);
      if (low === undefined) return undefined;
      if (low <= stop) {
        const next = prices.open(code, s + 1);
        return next === undefined
          ? undefined
          : { session: s + 1, priceMicro: next, reason: s + 1 === scheduled ? "time" : "stop" };
      }
    }
  }
  const out = prices.open(code, scheduled);
  return out === undefined ? undefined : { session: scheduled, priceMicro: out, reason: "time" };
}
