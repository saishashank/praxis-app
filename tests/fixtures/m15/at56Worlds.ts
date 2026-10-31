// AT-56 fixtures (1)-(11) as TypeScript ZZ worlds (M15 P3; spec ch. 17 AT-56; the M14 at43World.ts
// pattern: code, never CSV). One world per fixture, built on the C3b state-test builders
// (tests/cortex/states/zzStates.ts: forty weekday sessions from 2026-02-02, scripted raw closes in
// cents, one code per fixture). The assertions are in tests/acceptance/v2/at56.test.ts.
// Synthetic ZZ codes only (SEC-110).
import type { IndexViewBar } from "@/lib/agents/decisionView";
import type { EventRow, HaltRow } from "@/lib/cortex/pit/types";
import {
  eventAt,
  flatIndex,
  noticeAction,
  path,
  pct,
  SESSIONS,
  statesWorld,
  type FixtureSpec,
} from "../../cortex/states/zzStates";

export { SESSIONS, statesWorld };
export type { FixtureSpec };

/** Session index of the scripted event / break in the fixtures below. */
export const DAY0 = 25;
export const D0 = SESSIONS[DAY0]!;
export const BREAK = 10;
export const BREAK_D = SESSIONS[BREAK]!;
const KNOWN_D = SESSIONS[BREAK - 1]!;
const HEAVY = SESSIONS.map((_, i) => (i === DAY0 ? 500_000n : 100_000n)); // 5.5 x ADV20 notional

// (1) a single U2 notice with a named party but no value: `claimed`, no entry
export const F1_CLAIMED_EVENT: EventRow = eventAt("ZZS", D0, "contract_win", 1, pct(10));
export const F1_CLAIMED: FixtureSpec = {
  code: "ZZS",
  tier: "U2",
  bars: { closesCents: path(1000, DAY0, [0.1]) },
  events: [F1_CLAIMED_EVENT],
};

// (1b) with value and counterparty but 5.5 x ADV20 volume and an 8 %+ move: move-signature block
export const F1_MOVE_EVENT: EventRow = eventAt("ZZV", D0, "contract_win", 1, pct(10));
export const F1_MOVE: FixtureSpec = {
  code: "ZZV",
  tier: "U2",
  bars: { closesCents: path(1000, DAY0, [0.1]), volumes: HEAVY },
  events: [F1_MOVE_EVENT],
};

// (2) keyword-only title: a results keyword with a 0.5 % move, below max(2 %, 1.5 sigma)
export const F2_KEYWORD_EVENT: EventRow = eventAt("ZZT", D0, "results", 1, pct(0.5));
export const F2_KEYWORD: FixtureSpec = {
  code: "ZZT",
  tier: "U1",
  bars: { closesCents: path(1000, DAY0, [0.005]) },
  events: [F2_KEYWORD_EVENT],
};

// (3) a same-day US close: dated D, known D+1 09:00 Melbourne; the world carries GSPC and VIX bars
export function f3UsWorld() {
  const us = (level: bigint): IndexViewBar[] =>
    SESSIONS.map((d, i) => ({ d, close: (level + BigInt(i)) * 1_000_000n }));
  return statesWorld(
    [{ code: "ZZU", tier: "U1", bars: { closesCents: path(1000, 0, []) } }],
    { index: { AXJO: flatIndex(), GSPC: us(5_000n), VIX: us(15n) } },
  );
}

// (3b) a 2-for-1 candidate from an ASX notice; the chapter's raw -50 % on the break confirms by price
// (the stated ratio IS -50 %) and can never disconfirm, so the fixture is read with -30 % on the
// break (observed ratio 1.43, not confirmed) and -8 % on each of the next two sessions: disconfirmed
// on the second post-break failure (D-322; listed in the V2 PR because chapter 17 is frozen).
const split21 = (code: string) =>
  noticeAction(code, "split", BREAK_D, { new: 2, old: 1 }, KNOWN_D, ["announcement"], "pending");
export const F3B_DISCONFIRMED: FixtureSpec = {
  code: "ZZD",
  tier: "U1",
  bars: { closesCents: path(1000, BREAK, [-0.3, -0.08, -0.08]) },
  corpActions: [split21("ZZD")],
};

// (4) an untimed backfill row (date-only): known from the next session, event occurrence only
export const F4_UNTIMED_EVENT: EventRow = eventAt("ZZB", D0, "results", 1, null, {
  timed: false,
  publishedAt: D0, // date-only text = untimed backfill (OI-46)
});
export const F4_UNTIMED: FixtureSpec = {
  code: "ZZB",
  tier: "U1",
  bars: { closesCents: path(1000, 0, []) },
  events: [F4_UNTIMED_EVENT],
};

// (5) an unconfirmed split on a held code: raw -47.37 % on the break (ratio 1.9 against a stated 2)
export const F5_UNCONFIRMED: FixtureSpec = {
  code: "ZZE",
  tier: "U1",
  bars: { closesCents: path(1000, BREAK, [-0.4737]) },
  corpActions: [split21("ZZE")],
};
// (5b) the same notice on a price that follows the ratio exactly: confirmed, stops re-based
export const F5_CONFIRMED: FixtureSpec = {
  code: "ZZG",
  tier: "U1",
  bars: { closesCents: path(1000, BREAK, [-0.5]) },
  corpActions: [split21("ZZG")],
};

// (8a) a trading halt: sessions 5-7 have no bar
const haltRows = (a: number, b: number): HaltRow[] => [
  { d: SESSIONS[a]!, halted: true },
  ...(b + 1 < SESSIONS.length ? [{ d: SESSIONS[b + 1]!, halted: false }] : []),
];
export const F8_HALT: FixtureSpec = {
  code: "ZZM",
  tier: "U1",
  bars: { closesCents: path(1000, SESSIONS.length, []).map((v, i) => (i >= 5 && i <= 7 ? null : v)) },
  halts: haltRows(5, 7),
};
// (8b) a suspension from session 5 to the end of the world
export const F8_SUSPENSION: FixtureSpec = {
  code: "ZZO",
  tier: "U2",
  bars: { closesCents: path(1000, SESSIONS.length, []).map((v, i) => (i >= 5 ? null : v)) },
  halts: haltRows(5, SESSIONS.length - 1),
};

// (9) cold start: a world with a bar series long enough to read, go-live on the first session
export const F9_COLD: FixtureSpec = {
  code: "ZZA",
  tier: "U1",
  bars: { closesCents: path(1000, 0, []) },
};
