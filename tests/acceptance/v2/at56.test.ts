// @vitest-environment node
// AT-56 (M15; spec ch. 17 AT-56, outcomes the rules deliver): fixtures (1)-(11), one synthetic ZZ
// world per fixture (tests/fixtures/m15/at56Worlds.ts), each asserting the exact gate id and plain
// label the Cortex gives, by running the real state function and then the real gate on its result.
// Where the outcome is a state rather than a gate (a claimed notice, a candidate split's stop, the
// cold-start label) the state's own label is asserted, and the gate that reads it is named. Built
// although AT-56 is outside the ch. 14 gate (Q12). Synthetic ZZ codes only (SEC-110).
import { describe, expect, it } from "vitest";
import { REGIME_BLOCKS } from "@/lib/agents/families/constants";
import type { Family, RegimeLabel } from "@/lib/agents/families/types";
import {
  FAMILY_STATUS_LABEL,
  G08_LABELS,
  OPEN_LABELS,
  PARCEL_LABEL,
  REGIME_LABEL,
  SETTLED_CASH_LABEL,
  STALL_SESSIONS,
  WARMING_UP_LABEL,
  deployableCash,
  gateEligibility,
  gateEventState,
  gateFamilyStatus,
  gateRegime,
  gateSettledCash,
  openShockBlock,
  settlementDate,
  stallCheck,
  type EventStateInput,
  MIN_MARKETABLE_PARCEL_MICRO,
} from "@/lib/cortex/gates";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import type { AsOfView } from "@/lib/cortex/pit/types";
import { coldStartAt } from "@/lib/cortex/states/coldStart";
import {
  CORP_ACTION_NONE,
  stepCorpAction,
  twoBasisStop,
  type CorpActionState,
  type CorpActionStep,
} from "@/lib/cortex/states/corpAction";
import { eventEntryCheck, eventPolarityAt } from "@/lib/cortex/states/eventPolarity";
import {
  stepHalt,
  type HaltState,
  type HaltStep,
  type HaltStepInput,
} from "@/lib/cortex/states/halt";
import { stepPromotion, type PromotionState } from "@/lib/cortex/states/promotion";
import { makeRational } from "@/lib/money/rational";
import type { SettlementItem } from "@/lib/arena/ledger";
import type { CalendarRow } from "@/lib/data/calendar";
import { CENT } from "../../cortex/states/zzStates";
import {
  BREAK,
  D0,
  DAY0,
  F1_CLAIMED,
  F1_CLAIMED_EVENT,
  F1_MOVE,
  F1_MOVE_EVENT,
  F2_KEYWORD,
  F2_KEYWORD_EVENT,
  F3B_DISCONFIRMED,
  F4_UNTIMED,
  F4_UNTIMED_EVENT,
  F5_CONFIRMED,
  F5_UNCONFIRMED,
  F8_HALT,
  F8_SUSPENSION,
  F9_COLD,
  SESSIONS,
  f3UsWorld,
  statesWorld,
  type FixtureSpec,
} from "../../fixtures/m15/at56Worlds";

const M = 1_000_000n;
const c = (cents: number): bigint => BigInt(Math.round(cents * 100)) * (CENT / 100n);

/** The G08 input of a night with everything clear; a fixture overrides what it is about. */
function g08(t: number, over: Partial<EventStateInput> = {}): EventStateInput {
  return {
    d: SESSIONS[t]!,
    fillD: SESSIONS[t + 1]!,
    indexChangesLoaded: true,
    indexChanges: [],
    sessions: SESSIONS.slice(0, t + 1),
    indexChangeWindowSessions: 2,
    promotionState: "none",
    haltState: "none",
    haltedNow: false,
    corpActionState: "none",
    events: [],
    ...over,
  };
}

function walkCorp(spec: FixtureSpec, upTo: number): CorpActionStep[] {
  const view = buildAsOfView(statesWorld([spec]));
  const out: CorpActionStep[] = [];
  let s: CorpActionState | null = null;
  for (let t = 0; t <= upTo; t += 1) {
    const step = stepCorpAction(view, spec.code, t, s);
    out.push(step);
    s = step.next;
  }
  return out;
}

function walkHalt(spec: FixtureSpec, upTo: number, input: HaltStepInput = {}): HaltStep[] {
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

describe("fixture 1: a U2 notice with a named party but no value is `claimed` (no entry)", () => {
  const view = buildAsOfView(statesWorld([F1_CLAIMED]));

  it("polarity 0 with the label `claimed`, and no entry for a U2 contract notice", () => {
    expect(
      eventPolarityAt(view, "ZZS", DAY0, F1_CLAIMED_EVENT, { hasCounterparty: true }),
    ).toMatchObject({
      polarity: 0,
      label: "claimed",
    });
    expect(
      eventEntryCheck(view, "ZZS", DAY0 + 2, F1_CLAIMED_EVENT, { hasCounterparty: true }),
    ).toEqual({
      eligible: false,
      stage: "d2",
      label: "for a smaller company only results or guidance with parsed figures can start a trade",
      reason: "u23_category_not_entry",
    });
  });
});

describe("fixture 1b: value and counterparty on 5.5 x ADV20 and a 10 % move is a move-signature block", () => {
  const view = buildAsOfView(statesWorld([F1_MOVE]));
  let s: PromotionState | null = null;
  const states: PromotionState[] = [];
  for (let t = 0; t <= DAY0 + 6; t += 1) {
    const step = stepPromotion(view, "ZZV", t, s);
    states.push(step.next);
    s = step.next;
  }

  it("blocks entries for 5 sessions through G08 (8b) with the promotion label, whatever the title", () => {
    expect(F1_MOVE_EVENT.category).toBe("contract_win");
    for (let t = DAY0; t <= DAY0 + 4; t += 1) {
      expect(states[t]!.state).toBe("move_block");
      expect(gateEventState(g08(t, { promotionState: states[t]!.state }))).toEqual({
        pass: false,
        gateId: "G08_event_state",
        label: G08_LABELS["8b_promotion_flag"],
        value: "8b_promotion_flag:move_block",
      });
    }
    // the block ends after 5 sessions
    expect(states[DAY0 + 5]!.state).toBe("none");
    expect(gateEventState(g08(DAY0 + 5, { promotionState: states[DAY0 + 5]!.state })).pass).toBe(
      true,
    );
    expect(G08_LABELS["8b_promotion_flag"]).toBe("a promotion flag is in the way");
  });
});

describe("fixture 2: a keyword-only title has polarity 0", () => {
  const view = buildAsOfView(statesWorld([F2_KEYWORD]));

  it("a results keyword with a 0.5 % move (below max(2 %, 1.5 sigma)) is polarity 0 / no_move", () => {
    expect(eventPolarityAt(view, "ZZT", DAY0, F2_KEYWORD_EVENT)).toMatchObject({
      polarity: 0,
      label: "no_move",
      reason: "ar0_below_threshold",
    });
    // a U1 code has no entry on a notice without a verified direction
    expect(eventEntryCheck(view, "ZZT", DAY0 + 1, F2_KEYWORD_EVENT)).toMatchObject({
      eligible: false,
      label: "this notice has no verified direction",
    });
  });
});

describe("fixture 3: a same-day US close is unknown until D+1 09:00 Melbourne", () => {
  const view = buildAsOfView(f3UsWorld());

  it("the GSPC and VIX bars dated D are not in the view at D's cut-off, and are at D+1's", () => {
    for (const idx of ["GSPC", "VIX"] as const) {
      const atD = view.index(idx, DAY0, 1);
      expect(atD[atD.length - 1]!.d).toBe(SESSIONS[DAY0 - 1]); // yesterday's US close, not D's
      const atNext = view.index(idx, DAY0 + 1, 1);
      expect(atNext[atNext.length - 1]!.d).toBe(D0); // D's US close is known at D+1
    }
    // the same-day AXJO close is known at D's own cut-off
    const axjo = view.index("AXJO", DAY0, 1);
    expect(axjo[axjo.length - 1]!.d).toBe(D0);
  });
});

describe("fixture 3b: a 2-for-1 candidate whose price does not follow the ratio is disconfirmed", () => {
  // -30 % on the break, -8 % and -8 % after (D-322: the chapter's literal -50 % confirms by price).
  const steps = walkCorp(F3B_DISCONFIRMED, BREAK + 3);

  it("while a candidate, G08 8d stops entries; once disconfirmed the raw stop runs and G08 clears", () => {
    expect(steps[BREAK - 1]!.next.state).toBe("candidate");
    expect(
      gateEventState(g08(BREAK + 1, { corpActionState: steps[BREAK + 1]!.next.state })),
    ).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8d_unresolved_action"],
      value: "8d_unresolved_action:candidate",
    });
    const d2 = steps[BREAK + 2]!;
    expect(d2.next.state).toBe("disconfirmed");
    expect(d2.label).toBe(
      "the price did not move as the announced ratio said: the action is disconfirmed",
    );
    expect(d2.effects.stopBasis).toBe("raw");
    expect(gateEventState(g08(BREAK + 2, { corpActionState: d2.next.state })).pass).toBe(true);
  });
});

describe("fixture 4: an untimed backfill row is an event occurrence only, never an entry calibration", () => {
  const view = buildAsOfView(statesWorld([F4_UNTIMED]));

  it("is not known at its own day's cut-off; known from the next session", () => {
    expect(F4_UNTIMED_EVENT.timed).toBe(false);
    expect(view.events("ZZB", DAY0).map((e) => e.id)).toEqual([]);
    expect(view.events("ZZB", DAY0 + 1).map((e) => e.id)).toEqual([F4_UNTIMED_EVENT.id]);
  });

  it("carries no calibration: no AR0 means polarity 0 and no entry", () => {
    expect(eventPolarityAt(view, "ZZB", DAY0 + 1, F4_UNTIMED_EVENT)).toMatchObject({
      polarity: 0,
      reason: "no_ar0",
    });
    expect(eventEntryCheck(view, "ZZB", DAY0 + 1, F4_UNTIMED_EVENT)).toMatchObject({
      eligible: false,
      label: "this notice has no verified direction",
    });
  });
});

describe("fixture 5: an unconfirmed split on a held code", () => {
  const steps = walkCorp(F5_UNCONFIRMED, BREAK + 6);
  const stop = c(900);

  it("freezes: G08 8d stops entries; the stop is read on both bases, so no raw-price exit", () => {
    const brk = steps[BREAK]!;
    expect(brk.next.state).toBe("candidate");
    expect(gateEventState(g08(BREAK, { corpActionState: brk.next.state }))).toMatchObject({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8d_unresolved_action"],
    });
    expect(
      twoBasisStop({
        rawCloseMicro: c(526.3),
        stopMicro: stop,
        priceFactor: brk.effects.priceFactor,
      }),
    ).toEqual({ rawBreach: true, adjBreach: false, exit: false });
  });

  it("the Owner alert is raised on session 5 of the freeze with its label", () => {
    const s5 = steps[BREAK + 4]!;
    expect(s5.effects.ownerAlert).toBe(true);
    expect(s5.label).toBe(
      "Owner alert: a corporate action is unresolved and the prices do not agree with the notice",
    );
  });

  it("a confirmed 2-for-1 re-bases the stop and does not exit; G08 clears", () => {
    const ok = walkCorp(F5_CONFIRMED, BREAK + 1);
    const brk = ok[BREAK]!;
    expect(brk.next).toMatchObject({ state: "confirmed", rebased: true });
    expect(brk.label).toBe("a confirmed corporate action re-based the stop today");
    expect(brk.effects.rebase).toEqual({
      priceFactor: makeRational(2n),
      qtyRatio: makeRational(2n),
    });
    expect(gateEventState(g08(BREAK, { corpActionState: brk.next.state })).pass).toBe(true);
    expect(CORP_ACTION_NONE.state).toBe("none");
  });
});

describe("fixture 6: a SHOCK day with open positions", () => {
  const families: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

  it("G09 blocks every family but F4 in SHOCK, with the regime label; F4 passes at half size", () => {
    for (const f of families) {
      const g = gateRegime(f, "SHOCK");
      if (f === "F4") {
        expect(g).toEqual({ pass: true, value: "SHOCK:half_size", halfSize: true });
      } else {
        expect(g).toEqual({
          pass: false,
          gateId: "G09_regime",
          label: REGIME_LABEL,
          value: "SHOCK",
          halfSize: false,
        });
      }
    }
  });

  it("F4 at half size needs two parcels at G12 (A$900 fails, A$1,000 passes)", () => {
    expect(
      gateSettledCash({ deployableMicro: 900n * M, entryFeeMicro: 0n, halfSize: true }),
    ).toMatchObject({ pass: false, gateId: "G12_settled_cash", label: SETTLED_CASH_LABEL });
    expect(
      gateSettledCash({ deployableMicro: 1_000n * M, entryFeeMicro: 0n, halfSize: true }).pass,
    ).toBe(true);
  });

  it("the morning re-check cancels every pending buy but F4 in SHOCK (O03); stops are not touched", () => {
    for (const f of families) {
      const r = openShockBlock("SHOCK", f);
      if (f === "F4") expect(r.pass).toBe(true);
      else
        expect(r).toEqual({
          pass: false,
          openId: "O03_shock_block",
          label: OPEN_LABELS["O03_shock_block"],
          value: "SHOCK",
        });
    }
  });
});

describe("fixture 7: two capped stop-outs stall the book (designed)", () => {
  const maxLoss = makeRational(18n, 100n);

  it("the Owner item is raised before the second entry; five sessions below one parcel stall", () => {
    // A$700 book: the first capped loss (18 %) leaves A$574, within one capped loss of the A$500 floor
    const afterFirst = (700n * M * 82n) / 100n;
    const near = stallCheck(
      {
        hasOpenPosition: false,
        deployableMicro: afterFirst,
        unsettledProceedsMicro: 0n,
        runSessions: 0,
      },
      maxLoss,
    );
    expect(near.nearFloor).toBe(true); // the Owner item, before the second entry
    // the second capped loss leaves A$470.7: below one parcel
    const afterSecond = (afterFirst * 82n) / 100n;
    expect(afterSecond < MIN_MARKETABLE_PARCEL_MICRO).toBe(true);
    let run = 0;
    let stalled = false;
    for (let i = 0; i < STALL_SESSIONS; i += 1) {
      const r = stallCheck(
        {
          hasOpenPosition: false,
          deployableMicro: afterSecond,
          unsettledProceedsMicro: 0n,
          runSessions: run,
        },
        maxLoss,
      );
      run = r.runSessions;
      stalled = r.stalled;
    }
    expect(stalled).toBe(true);
    // the entry itself, below one parcel, is refused at G12 with the parcel label
    expect(
      gateSettledCash({ deployableMicro: afterSecond, entryFeeMicro: 0n, halfSize: false }),
    ).toMatchObject({ pass: false, gateId: "G12_settled_cash" });
    expect(PARCEL_LABEL).toBe("the position would be too small to be worth placing");
  });
});

describe("fixture 8: a halt is marked, a suspension is a declining mark counted as a loss", () => {
  it("a trading halt: G08 8c stops entries with the halt label; no bust, the mark is the last trade", () => {
    const steps = walkHalt(F8_HALT, 8);
    const h = steps[5]!;
    expect(h.next.state).toBe("halt");
    expect(h.label).toBe("a trading halt is in the way");
    expect(h.effects.markMicro).toBe(c(1000));
    expect(gateEventState(g08(5, { haltState: h.next.state, haltedNow: true }))).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8c_halt_suspension"],
      value: "8c_halt_suspension:halted",
    });
    expect(steps[8]!.next.state).toBe("none"); // reopened: the way is clear
  });

  it("a suspension: G08 8c with the suspension word; the label says it is counted as a loss", () => {
    const steps = walkHalt(F8_SUSPENSION, 12, { notices: new Map([[SESSIONS[5]!, "suspension"]]) });
    const s = steps[5]!;
    expect(s.next.state).toBe("suspension");
    expect(s.label).toBe(`suspended since ${SESSIONS[5]}: marked down and counted as a loss`);
    // from session 10 (untraded 6) the mark is below par (90 %)
    expect(steps[10]!.effects.markPct).toBe(90);
    expect(gateEventState(g08(6, { haltState: steps[6]!.next.state, haltedNow: false }))).toEqual({
      pass: false,
      gateId: "G08_event_state",
      label: G08_LABELS["8c_halt_suspension"],
      value: "8c_halt_suspension:suspension",
    });
  });
});

describe("fixture 9: cold start, session 3 -> `warming up`, no fault", () => {
  const view: AsOfView = buildAsOfView(statesWorld([F9_COLD]));
  const GO_LIVE = SESSIONS[0]!;

  it("the state label, the family set, and G02 with the warming-up label (never a fault)", () => {
    const r = coldStartAt(view, 2, { goLiveD: GO_LIVE, abstainRatePct: 100 }, false);
    expect(r.state).toMatchObject({
      phase: "cold",
      sessionNumber: 3,
      familiesAllowed: ["F1", "F4"],
      label: "warming up (session 3 of 20)",
    });
    expect(r.abstainAlarm).toBe(false);
    // an angle with too little history is not computable: G02 fails with the plain warming-up line
    expect(
      gateEligibility({
        eligible: false,
        reason: "warming_up",
        missing: ["A-D1-01"],
        label: WARMING_UP_LABEL,
      }),
    ).toEqual({
      pass: false,
      gateId: "G02_eligibility",
      label: "we do not have enough history on this company yet (warming up)",
      value: "A-D1-01",
    });
    // a family outside the cold set fails G03 with the status label
    expect(
      gateFamilyStatus({ status: "allowed", killed: false, coldStartExcluded: true }),
    ).toMatchObject({ pass: false, gateId: "G03_family_status", label: FAMILY_STATUS_LABEL });
  });
});

describe("fixture 10: a Monday sale cannot fund a Tuesday buy (settled-cash gate)", () => {
  const sessions = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"];
  const calendar: CalendarRow[] = sessions.map((d) => ({
    d,
    kind: "session",
    close_time: null,
    confirmed: 1,
  }));
  const sale: SettlementItem = {
    fillId: "f-sell-1",
    side: "sell",
    tradeD: "2026-03-02",
    settleD: settlementDate("2026-03-02", calendar),
    netMicro: 2_000n * M,
  };
  const cash = { settledCashMicro: 300n * M, pending: [sale] };

  it("refused on Tuesday with G12 and its label; funded on Wednesday", () => {
    expect(
      gateSettledCash({
        deployableMicro: deployableCash(cash, "2026-03-03"),
        entryFeeMicro: 3n * M,
        halfSize: false,
      }),
    ).toMatchObject({ pass: false, gateId: "G12_settled_cash", label: SETTLED_CASH_LABEL });
    expect(
      gateSettledCash({
        deployableMicro: deployableCash(cash, "2026-03-04"),
        entryFeeMicro: 3n * M,
        halfSize: false,
      }).pass,
    ).toBe(true);
    expect(SETTLED_CASH_LABEL).toBe("the cash from the last sale has not settled yet");
  });
});

describe("fixture 11: the regime matrix", () => {
  const families: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
  const regimes: readonly RegimeLabel[] = ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"];

  it("F3 never enters SHOCK; F2 enters RISK-OFF; every cell equals the one CTX-017 table", () => {
    expect(gateRegime("F3", "SHOCK")).toMatchObject({
      pass: false,
      gateId: "G09_regime",
      label: REGIME_LABEL,
    });
    expect(gateRegime("F2", "RISK-OFF").pass).toBe(true);
    for (const f of families) {
      for (const r of regimes) {
        const g = gateRegime(f, r);
        expect(g.pass).toBe(!REGIME_BLOCKS[f].includes(r));
        if (!g.pass)
          expect(g).toMatchObject({ gateId: "G09_regime", label: REGIME_LABEL, value: r });
      }
    }
  });
});
