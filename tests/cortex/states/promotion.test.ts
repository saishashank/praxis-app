// @vitest-environment node
// CTX-044 promotion flag (M15 C3b; AT-56 fixture 1 "move-signature block for 5 sessions whatever
// the title"): the two triggers, the results exemption, the exchange-query review item, the review
// verdicts and the U2/U3 scope.
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import {
  isMoveSignature,
  PROMOTION_NONE,
  promotionStateAt,
  stepPromotion,
  type PromotionInput,
  type PromotionState,
  type PromotionStep,
} from "@/lib/cortex/states/promotion";
import { eventAt, path, pct, SESSIONS, statesWorld, type FixtureSpec } from "./zzStates";

const DAY0 = 25;
const D0 = SESSIONS[DAY0]!;

function walk(spec: FixtureSpec, upTo: number, input: PromotionInput = {}): PromotionStep[] {
  const view = buildAsOfView(statesWorld([spec]));
  const out: PromotionStep[] = [];
  let s: PromotionState | null = null;
  for (let t = 0; t <= upTo; t += 1) {
    const step = stepPromotion(view, spec.code, t, s, undefined, input);
    out.push(step);
    s = step.next;
  }
  return out;
}

const heavy = SESSIONS.map((_, i) => (i === DAY0 ? 500_000n : 100_000n)); // 5.5 x ADV20 notional

describe("fixture 1: a U2 contract with value and counterparty on 4 x volume and an 8 % move", () => {
  const ev = eventAt("ZZV", D0, "contract_win", 1, pct(10));
  const spec: FixtureSpec = {
    code: "ZZV",
    tier: "U2",
    bars: { closesCents: path(1000, DAY0, [0.1]), volumes: heavy },
    events: [ev],
  };
  const steps = walk(spec, DAY0 + 6);

  it("is a move signature that blocks entries for 5 sessions whatever the title", () => {
    const s = steps[DAY0]!;
    expect(s.next).toEqual({ state: "move_block", fromD: D0, sessions: 5 });
    expect(s.label).toBe("a sharp move on heavy volume blocks entries for now");
    expect(s.reason).toBe("move_signature");
    expect(s.row).toMatchObject({
      kind: "promotion",
      code: "ZZV",
      fromD: D0,
      state: "move_block",
      basis: { ar0: "1/10" },
    });
    expect(s.effects).toMatchObject({
      entriesBlocked: true,
      zeroPositive: false,
      moveSignature: true,
      reviewItem: false,
      count: 1,
    });
    for (let t = DAY0 + 1; t <= DAY0 + 4; t += 1) {
      expect(steps[t]!.next.state).toBe("move_block");
      expect(steps[t]!.row).toBeNull();
      expect(steps[t]!.effects.entriesBlocked).toBe(true);
    }
    const end = steps[DAY0 + 5]!;
    expect(end.next).toEqual(PROMOTION_NONE);
    expect(end.row).toMatchObject({ state: "none", basis: { after: "move_block" } });
    expect(end.effects.entriesBlocked).toBe(false);
    expect(steps[DAY0 + 6]!.row).toBeNull();
  });

  it("the same move without a notice is also a signature (and counts as an item)", () => {
    const bare: FixtureSpec = { ...spec, code: "ZZV2", events: [] };
    const s = walk(bare, DAY0)[DAY0]!;
    expect(s.next.state).toBe("move_block");
    expect(s.effects.count).toBe(1);
  });

  it("a results release with parsed financial statements is exempt", () => {
    const results = eventAt("ZZV3", D0, "results", 1, pct(10));
    const ex: FixtureSpec = { ...spec, code: "ZZV3", events: [results] };
    const facts = new Map([[results.id, { financialsParsed: true }]]);
    const s = walk(ex, DAY0, { facts })[DAY0]!;
    expect(s.next).toEqual(PROMOTION_NONE);
    expect(s.effects).toMatchObject({ entriesBlocked: false, moveSignature: false, count: 0 });
    // the same release without parsed figures does not exempt
    expect(walk(ex, DAY0)[DAY0]!.next.state).toBe("move_block");
    const view = buildAsOfView(statesWorld([ex]));
    expect(isMoveSignature(view, "ZZV3", DAY0, [results], {}, { ...DEFAULTS })).toBe(true);
  });

  it("below either threshold it is not a signature", () => {
    const smallMove: FixtureSpec = {
      ...spec,
      code: "ZZV4",
      bars: { closesCents: path(1000, DAY0, [0.07]), volumes: heavy },
      events: [],
    };
    expect(walk(smallMove, DAY0)[DAY0]!.next.state).toBe("none");
    const thin: FixtureSpec = {
      ...spec,
      code: "ZZV5",
      bars: { closesCents: path(1000, DAY0, [0.1]) },
      events: [],
    };
    expect(walk(thin, DAY0)[DAY0]!.next.state).toBe("none");
  });
});

const DEFAULTS = {
  pumpVolumeMult: 4,
  pumpArPct: 8,
  moveBlockSessions: 5,
  promotionFlagSessions: 20,
  noticeCountFlag: 3,
  noticeCountFlagWithAr: 2,
  noticeCountArPct: 5,
  persistAdvSessions: 20,
};

describe("notice-and-move count", () => {
  const notice = (code: string, i: number, ar: number) =>
    eventAt(code, SESSIONS[i]!, "management_change", 1, pct(ar));

  it("three notices with a polarity in 20 sessions flag the code for 20 sessions from the last one", () => {
    const spec: FixtureSpec = {
      code: "ZZX",
      tier: "U3",
      bars: { closesCents: path(1000, 0, []) },
      events: [notice("ZZX", 3, 1), notice("ZZX", 6, 1), notice("ZZX", 9, 1)],
    };
    const steps = walk(spec, 30);
    expect(steps[6]!.next.state).toBe("none");
    expect(steps[6]!.effects.count).toBe(2);
    const f = steps[9]!;
    expect(f.next).toEqual({
      state: "flagged",
      fromD: SESSIONS[9],
      sessions: 20,
      by: "count",
      count: 3,
    });
    expect(f.label).toBe("a promotion flag is in the way");
    expect(f.row).toMatchObject({
      state: "flagged",
      basis: { by: "count", count: 3, sessions: 20 },
    });
    expect(f.effects).toMatchObject({ entriesBlocked: true, zeroPositive: true });
    expect(steps[10]!.row).toBeNull();
    // the window: on session 23 the first notice (session 3) drops out and the count is 2
    expect(steps[23]!.effects.count).toBe(2);
    expect(steps[23]!.next.state).toBe("flagged"); // still runs 20 sessions from the last counted notice
    expect(steps[29]!.next).toEqual(PROMOTION_NONE);
    expect(steps[29]!.row).toMatchObject({ state: "none", basis: { after: "flagged" } });
  });

  it("two notices flag when one came with an AR0 above 5 %", () => {
    const spec: FixtureSpec = {
      code: "ZZY",
      tier: "U2",
      bars: { closesCents: path(1000, 0, []) },
      events: [notice("ZZY", 3, 6), notice("ZZY", 6, 1)],
    };
    const steps = walk(spec, 6);
    expect(steps[3]!.next.state).toBe("none");
    expect(steps[6]!.next).toMatchObject({ state: "flagged", count: 2, by: "count" });
    const two: FixtureSpec = {
      ...spec,
      code: "ZZY2",
      events: [notice("ZZY2", 3, 1), notice("ZZY2", 6, 1)],
    };
    expect(walk(two, 6)[6]!.next.state).toBe("none");
  });

  it("results and guidance with parsed numbers are exempt from the count only; polarity-0 notices never count", () => {
    const r1 = eventAt("ZZZ", SESSIONS[3]!, "results", 1, pct(1));
    const r2 = eventAt("ZZZ", SESSIONS[6]!, "guidance_up", 1, pct(1));
    const zero = eventAt("ZZZ", SESSIONS[9]!, "other", 0, pct(1));
    const spec: FixtureSpec = {
      code: "ZZZ",
      tier: "U2",
      bars: { closesCents: path(1000, 0, []) },
      events: [r1, r2, zero, notice("ZZZ", 12, 1)],
    };
    const facts = new Map([
      [r1.id, { financialsParsed: true }],
      [r2.id, { financialsParsed: true }],
    ]);
    expect(walk(spec, 12, { facts })[12]!.effects.count).toBe(1);
    expect(walk(spec, 12)[12]!.effects.count).toBe(3);
  });
});

describe("exchange query and review verdicts (OI-35)", () => {
  const spec: FixtureSpec = {
    code: "ZZQ",
    tier: "U2",
    bars: { closesCents: path(1000, 0, []) },
    events: [eventAt("ZZQ", SESSIONS[5]!, "exchange_query", -1, pct(-3))],
  };

  it("a query opens a review item only: no flag, no block", () => {
    const s = walk(spec, 6);
    expect(s[5]!.next).toEqual(PROMOTION_NONE);
    expect(s[5]!.reason).toBe("exchange_query_review");
    expect(s[5]!.effects).toMatchObject({
      reviewItem: true,
      entriesBlocked: false,
      zeroPositive: false,
    });
    expect(s[6]!.effects.reviewItem).toBe(false);
  });

  it("a contradicted response sets the flag; a satisfactory one releases it", () => {
    const review = new Map([
      [SESSIONS[7]!, "contradicted" as const],
      [SESSIONS[9]!, "satisfactory" as const],
    ]);
    const s = walk(spec, 10, { review });
    expect(s[7]!.next).toMatchObject({ state: "flagged", by: "contradicted", fromD: SESSIONS[7] });
    expect(s[7]!.row).toMatchObject({ state: "flagged", basis: { by: "contradicted" } });
    expect(s[8]!.next.state).toBe("flagged");
    expect(s[9]!.next).toEqual(PROMOTION_NONE);
    expect(s[9]!.row).toMatchObject({ state: "none", basis: { after: "flagged" } });
  });
});

describe("scope and purity", () => {
  it("a U1 code is never flagged or blocked", () => {
    const ev = eventAt("ZZU1", D0, "contract_win", 1, pct(10));
    const spec: FixtureSpec = {
      code: "ZZU1",
      tier: "U1",
      bars: { closesCents: path(1000, DAY0, [0.1]), volumes: heavy },
      events: [ev],
    };
    const s = walk(spec, DAY0)[DAY0]!;
    expect(s.next).toEqual(PROMOTION_NONE);
    expect(s.reason).toBe("not_u23");
  });

  it("promotionStateAt equals the walked state at every t", () => {
    const ev = eventAt("ZZV", D0, "contract_win", 1, pct(10));
    const spec: FixtureSpec = {
      code: "ZZV",
      tier: "U2",
      bars: { closesCents: path(1000, DAY0, [0.1]), volumes: heavy },
      events: [ev],
    };
    const view = buildAsOfView(statesWorld([spec]));
    const steps = walk(spec, DAY0 + 6);
    for (let t = 0; t <= DAY0 + 6; t += 1)
      expect(promotionStateAt(view, "ZZV", t).next).toEqual(steps[t]!.next);
  });
});
