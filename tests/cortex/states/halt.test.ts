// @vitest-environment node
// CTX-016 halt vs suspension (M15 C3b; AT-56 fixture 8; D-272 mark policy fixed): the classifier,
// the halt mark at the last trade, the reopen-gap exit, the declining suspension mark counted as a
// loss, serial halts, the 10-traded-session end and the outcome class.
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import type { HaltRow } from "@/lib/cortex/pit/types";
import {
  HALT_NONE,
  haltNoticeKind,
  haltStateAt,
  markAtPct,
  stepHalt,
  suspensionMarkPct,
  type HaltState,
  type HaltStep,
  type HaltStepInput,
} from "@/lib/cortex/states/halt";
import { CENT, noticeAction, path, SESSIONS, statesWorld, type FixtureSpec } from "./zzStates";

const c = (cents: number): bigint => BigInt(cents) * CENT;

/** Closes with nulls (no bar) on the halted sessions. */
function closesHalted(
  haltedIdx: readonly number[],
  opens?: Record<number, number>,
): FixtureSpec["bars"] {
  const closes = path(1000, SESSIONS.length, []).map((v, i) => (haltedIdx.includes(i) ? null : v));
  const opensCents = closes.map((v, i) => (opens && opens[i] !== undefined ? opens[i]! : v));
  return { closesCents: closes, opensCents };
}

function haltRows(ranges: readonly [number, number][]): HaltRow[] {
  const rows: HaltRow[] = [];
  for (const [a, b] of ranges) {
    rows.push({ d: SESSIONS[a]!, halted: true });
    if (b + 1 < SESSIONS.length) rows.push({ d: SESSIONS[b + 1]!, halted: false });
  }
  return rows;
}

function walk(spec: FixtureSpec, upTo: number, input: HaltStepInput = {}): HaltStep[] {
  const view = buildAsOfView(statesWorld([spec]));
  const out: HaltStep[] = [];
  let s: HaltState | null = null;
  for (let t = 0; t <= upTo; t += 1) {
    const step = stepHalt(view, spec.code, t, s, undefined, input);
    out.push(step);
    s = step.next;
  }
  return out;
}

describe("classifier words", () => {
  it("reads a trading halt and a suspension from the ASX notice words", () => {
    expect(haltNoticeKind("trading halt", "Trading Halt")).toBe("halt");
    expect(haltNoticeKind(null, "Suspension from Official Quotation")).toBe("suspension");
    expect(haltNoticeKind(null, "Voluntary Suspension")).toBe("suspension");
    expect(haltNoticeKind("results", "Half-year results")).toBeNull();
  });
});

describe("fixture 8a: a trading halt is marked at the last trade and never busts a book", () => {
  const spec: FixtureSpec = {
    code: "ZZM",
    tier: "U1",
    bars: closesHalted([5, 6, 7]),
    halts: haltRows([[5, 7]]),
  };
  const steps = walk(spec, 9);

  it("enters 'halt' with the pre-halt close as the mark, no exit fills, no entries", () => {
    expect(steps[4]!.next).toEqual(HALT_NONE);
    const h = steps[5]!;
    expect(h.next).toMatchObject({
      state: "halt",
      sinceD: SESSIONS[5],
      markMicro: c(1000),
      runSessions: 1,
    });
    expect(h.label).toBe("a trading halt is in the way");
    expect(h.row).toMatchObject({ kind: "halt", code: "ZZM", fromD: SESSIONS[5], state: "halt" });
    expect(h.effects).toMatchObject({
      entriesBlocked: true,
      exitFillsBlocked: true,
      markMicro: c(1000),
      markPct: null,
    });
    expect(steps[7]!.next).toMatchObject({ state: "halt", runSessions: 3 });
    expect(steps[7]!.row).toBeNull();
  });

  it("reopens to 'none' with a row; a small gap is no exit", () => {
    const r = steps[8]!;
    expect(r.next).toEqual(HALT_NONE);
    expect(r.label).toBe("the trading halt is over");
    expect(r.row).toMatchObject({ state: "none", basis: { after: "halt", reopenGapExit: false } });
    expect(r.effects.reopenGapExit).toBe(false);
    expect(steps[9]!.row).toBeNull();
  });

  it("a reopen gap beyond max_loss_pct (18 %) exits at the reopen open", () => {
    const gap: FixtureSpec = { ...spec, code: "ZZN", bars: closesHalted([5, 6, 7], { 8: 700 }) };
    const s = walk(gap, 8);
    const r = s[8]!;
    expect(r.next).toEqual(HALT_NONE);
    expect(r.reason).toBe("reopen_gap_exit");
    expect(r.label).toBe(
      "the stock reopened far below where it halted: the position exits at the reopen",
    );
    expect(r.effects.reopenGapExit).toBe(true);
    // exactly -18 % is not beyond the budget
    const edge: FixtureSpec = { ...spec, code: "ZZN2", bars: closesHalted([5, 6, 7], { 8: 820 }) };
    expect(walk(edge, 8)[8]!.effects.reopenGapExit).toBe(false);
  });
});

describe("fixture 8b: a suspension is marked on the declining policy and counted as a loss", () => {
  const spec: FixtureSpec = {
    code: "ZZO",
    tier: "U2",
    bars: closesHalted(SESSIONS.map((_, i) => i).filter((i) => i >= 5)),
    halts: haltRows([[5, SESSIONS.length - 1]]),
  };
  const input: HaltStepInput = { notices: new Map([[SESSIONS[5]!, "suspension"]]) };
  const steps = walk(spec, SESSIONS.length - 1, input);

  it("the policy: 100 % for 5 sessions, then -10 points per 5, floor 50 %", () => {
    const table = [1, 5, 6, 10, 11, 15, 16, 20, 21, 25, 26, 30, 31, 100].map((n) =>
      suspensionMarkPct(n),
    );
    expect(table).toEqual([100, 100, 90, 90, 80, 80, 70, 70, 60, 60, 50, 50, 50, 50]);
    expect(() => suspensionMarkPct(0)).toThrow(RangeError);
    expect(markAtPct(c(1000), 90)).toBe(c(900));
  });

  it("enters 'suspension' on the notice with the mark and the 'suspended since' label", () => {
    const s = steps[5]!;
    expect(s.next).toMatchObject({
      state: "suspension",
      sinceD: SESSIONS[5],
      lastTradeMicro: c(1000),
      untradedSessions: 1,
      outcome: "unknown",
    });
    expect(s.reason).toBe("suspension_notice");
    expect(s.label).toBe(`suspended since ${SESSIONS[5]}: marked down and counted as a loss`);
    expect(s.row).toMatchObject({ state: "suspension", fromD: SESSIONS[5] });
    expect(s.effects).toMatchObject({
      entriesBlocked: true,
      exitFillsBlocked: true,
      markMicro: c(1000),
      markPct: 100,
      suspendedSince: SESSIONS[5],
    });
  });

  it("marks decline with the untraded sessions and never go below the floor", () => {
    const pctAt = (t: number): number | null => steps[t]!.effects.markPct;
    expect(pctAt(9)).toBe(100); // untraded 5
    expect(pctAt(10)).toBe(90); // untraded 6
    expect(steps[10]!.effects.markMicro).toBe(c(900));
    expect(pctAt(14)).toBe(90);
    expect(pctAt(15)).toBe(80);
    expect(pctAt(30)).toBe(50); // untraded 26
    expect(pctAt(39)).toBe(50); // untraded 35: floor
    expect(steps[39]!.effects.markMicro).toBe(c(500));
    expect(steps.slice(6).every((s) => s.row === null && s.next.state === "suspension")).toBe(true);
  });

  it("D-323: a delisting ends the suspension on its ex-date; administration books zero", () => {
    const del: FixtureSpec = {
      ...spec,
      code: "ZZR",
      corpActions: [
        noticeAction(
          "ZZR",
          "delisting",
          SESSIONS[12]!,
          { reason: "administration" },
          SESSIONS[11]!,
          ["announcement"],
          "confirmed",
        ),
      ],
    };
    const s = walk(del, 13, { notices: new Map([[SESSIONS[5]!, "suspension"]]) });
    expect(s[10]!.effects.outcome).toBe("unknown");
    expect(s[11]!.effects.outcome).toBe("delisted"); // known, not yet effective: still suspended
    expect(s[11]!.next.state).toBe("suspension");
    const x = s[12]!;
    expect(x.next).toEqual(HALT_NONE);
    expect(x.reason).toBe("suspension_delisted");
    expect(x.label).toBe(
      `delisted while suspended since ${SESSIONS[5]}: the position is booked at its final value`,
    );
    expect(x.row).toMatchObject({
      state: "none",
      fromD: SESSIONS[12],
      basis: { after: "suspension", outcome: "delisted", markMicro: "0" },
    });
    expect(x.effects).toMatchObject({ outcome: "delisted", delistExit: { markMicro: 0n } });
    expect(s[13]!.next).toEqual(HALT_NONE);
    expect(s[13]!.row).toBeNull();
  });

  it("D-323: a voluntary delisting books the final policy value (90 % on untraded session 8)", () => {
    const del: FixtureSpec = {
      ...spec,
      code: "ZZR2",
      corpActions: [
        noticeAction(
          "ZZR2",
          "delisting",
          SESSIONS[12]!,
          { reason: "voluntary" },
          SESSIONS[11]!,
          ["announcement"],
          "confirmed",
        ),
      ],
    };
    const s = walk(del, 12, { notices: new Map([[SESSIONS[5]!, "suspension"]]) });
    // sessions 5..12 untraded = 8 -> 90 % of the 1000c last trade
    expect(s[12]!.effects.delistExit).toEqual({ markMicro: c(900) });
    expect(s[12]!.row).toMatchObject({ basis: { markMicro: c(900).toString() } });
  });

  it("D-324: an unknown halt flag during a suspension reads as untraded", () => {
    // halt rows end at session 10 with no later row: `halted` is false from 11 (known), so the
    // traded run grows; a code with no halt table at all reads null -> untraded, run stays 0
    const noTable: FixtureSpec = { ...spec, code: "ZZR3", halts: undefined };
    const view = buildAsOfView(statesWorld([noTable]));
    const start: HaltState = {
      state: "suspension",
      sinceD: SESSIONS[5]!,
      lastTradeMicro: c(1000),
      untradedSessions: 1,
      tradedRun: 0,
      outcome: "unknown",
    };
    const step = stepHalt(view, "ZZR3", 6, start);
    expect(step.next).toMatchObject({ state: "suspension", tradedRun: 0, untradedSessions: 2 });
    expect(step.effects.markPct).toBe(100);
  });
});

describe("classifier by duration and count", () => {
  it("a halt beyond 5 sessions becomes a suspension; 10 traded sessions end it as reinstated", () => {
    const spec: FixtureSpec = {
      code: "ZZQ",
      tier: "U1",
      bars: closesHalted([5, 6, 7, 8, 9, 10]),
      halts: haltRows([[5, 10]]),
    };
    const steps = walk(spec, 21);
    expect(steps[9]!.next).toMatchObject({ state: "halt", runSessions: 5 });
    const s = steps[10]!;
    expect(s.next).toMatchObject({
      state: "suspension",
      sinceD: SESSIONS[10],
      lastTradeMicro: c(1000),
    });
    expect(s.reason).toBe("halt_too_long");
    expect(s.row).toMatchObject({ state: "suspension", basis: { haltSince: SESSIONS[5] } });
    // trading resumes on session 11: marked at market, still suspended, entries blocked
    expect(steps[11]!.effects).toMatchObject({
      entriesBlocked: true,
      exitFillsBlocked: false,
      markMicro: null,
      markPct: null,
    });
    expect(steps[11]!.reason).toBe("suspension_traded_session");
    expect(steps[19]!.next).toMatchObject({ state: "suspension", tradedRun: 9 });
    const end = steps[20]!;
    expect(end.next).toEqual(HALT_NONE);
    expect(end.reason).toBe("suspension_ended");
    expect(end.label).toBe("trading has resumed for long enough: the suspension is over");
    expect(end.row).toMatchObject({
      state: "none",
      basis: { after: "suspension", outcome: "reinstated" },
    });
    expect(end.effects.outcome).toBe("reinstated");
    expect(steps[21]!.row).toBeNull();
  });

  it("five halted sessions in any twenty count cumulatively as a suspension", () => {
    const idx = [2, 5, 8, 11, 14];
    const spec: FixtureSpec = {
      code: "ZZP",
      tier: "U1",
      bars: closesHalted(idx),
      halts: haltRows(idx.map((i) => [i, i] as [number, number])),
    };
    const steps = walk(spec, 14);
    for (const i of idx.slice(0, 4)) {
      expect(steps[i]!.next.state).toBe("halt");
      expect(steps[i + 1]!.next).toEqual(HALT_NONE);
    }
    const s = steps[14]!;
    expect(s.next).toMatchObject({ state: "suspension", sinceD: SESSIONS[14] });
    expect(s.reason).toBe("serial_halts");
    expect(s.row).toMatchObject({ state: "suspension" });
  });

  it("haltStateAt folds from the first session and equals the walk", () => {
    const spec: FixtureSpec = {
      code: "ZZM",
      tier: "U1",
      bars: closesHalted([5, 6, 7]),
      halts: haltRows([[5, 7]]),
    };
    const view = buildAsOfView(statesWorld([spec]));
    expect(haltStateAt(view, "ZZM", 6).next).toEqual(walk(spec, 6)[6]!.next);
    expect(haltStateAt(view, "ZZM", 8).effects.reopenGapExit).toBe(false);
  });
});
