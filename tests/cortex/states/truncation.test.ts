// @vitest-environment node
// TST-109 on every C3b state function (CTX-010; docs/M15_design.md 3a "Fixed rules"): the state at
// t computed on the full view equals the state computed on a view built from the world physically
// cut at t, for every t and every fixture code. A mismatch means a state read past the cut-off.
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant, truncationMismatches } from "@/lib/cortex/pit/truncation";
import type { AsOfView, HaltRow } from "@/lib/cortex/pit/types";
import { coldStartAt } from "@/lib/cortex/states/coldStart";
import { corpActionStateAt } from "@/lib/cortex/states/corpAction";
import { eventEntryCheck, eventPolarityAt } from "@/lib/cortex/states/eventPolarity";
import { haltStateAt, type HaltStepInput } from "@/lib/cortex/states/halt";
import { promotionStateAt, type PromotionInput } from "@/lib/cortex/states/promotion";
import {
  eventAt,
  noticeAction,
  path,
  pct,
  SESSIONS,
  statesWorld,
  type FixtureSpec,
} from "./zzStates";

const BREAK = 25;
const EX = SESSIONS[BREAK]!;
const KNOWN = SESSIONS[BREAK - 1]!;
const heavy = SESSIONS.map((_, i) =>
  i === BREAK ? 500_000n : i === BREAK + 1 ? 300_000n : 100_000n,
);
const haltedIdx = [5, 6, 7];
const haltRows: HaltRow[] = [
  { d: SESSIONS[5]!, halted: true },
  { d: SESSIONS[8]!, halted: false },
  { d: SESSIONS[20]!, halted: true },
];

const results = eventAt("ZZU", EX, "results", 1, pct(10));
const contract = eventAt("ZZV", EX, "contract_win", 1, pct(10));

const fixtures: FixtureSpec[] = [
  // corporate actions: an unconfirmed notice, a vendor-only ratio and a jump
  {
    code: "ZZE",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.4737, -0.3]) },
    corpActions: [noticeAction("ZZE", "split", EX, { new: 2, old: 1 }, KNOWN)],
  },
  {
    code: "ZZH",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.5]) },
    corpActions: [
      noticeAction("ZZH", "split", EX, { new: 2, old: 1 }, SESSIONS[BREAK - 2]!),
      noticeAction("ZZH", "split", EX, { new: 2, old: 1 }, KNOWN, ["vendor"]),
    ],
  },
  {
    code: "ZZD",
    tier: "U1",
    bars: { closesCents: path(1000, BREAK, [-0.4, -0.08, -0.08]) },
    corpActions: [noticeAction("ZZD", "split", EX, { new: 2, old: 1 }, KNOWN)],
  },
  // halts: a three-session halt with a reopen gap, then a suspension from session 20
  {
    code: "ZZM",
    tier: "U1",
    bars: {
      closesCents: path(1000, 0, []).map((v, i) => (haltedIdx.includes(i) || i >= 20 ? null : v)),
      opensCents: path(1000, 0, []).map((v, i) => (i === 8 ? 700 : v)),
    },
    halts: haltRows,
  },
  // events and promotion on U2 codes
  {
    code: "ZZU",
    tier: "U2",
    bars: { closesCents: path(1000, BREAK, [0.1, 0]), volumes: heavy },
    events: [results],
  },
  {
    code: "ZZV",
    tier: "U2",
    bars: { closesCents: path(1000, BREAK, [0.1]), volumes: heavy },
    events: [
      contract,
      eventAt("ZZV", SESSIONS[3]!, "management_change", 1, pct(6)),
      eventAt("ZZV", SESSIONS[33]!, "exchange_query", -1, pct(-3)),
    ],
  },
];
const world = statesWorld(fixtures);
const codes = fixtures.map((f) => f.code);
const facts = new Map([
  [results.id, { financialsParsed: true }],
  [contract.id, { hasValue: true, hasCounterparty: true }],
]);
const haltInput: HaltStepInput = { notices: new Map([[SESSIONS[20]!, "suspension"]]) };
const promoInput: PromotionInput = { facts, review: new Map([[SESSIONS[35]!, "contradicted"]]) };

describe("TST-109 truncation on each state function", () => {
  it("corporate-action state", () => {
    assertTruncationInvariant(world, (v, code, t) => corpActionStateAt(v, code, t), { codes });
  });

  it("halt / suspension state", () => {
    assertTruncationInvariant(
      world,
      (v, code, t) => haltStateAt(v, code, t, undefined, haltInput),
      { codes },
    );
  });

  it("promotion state", () => {
    assertTruncationInvariant(
      world,
      (v, code, t) => promotionStateAt(v, code, t, undefined, promoInput),
      { codes },
    );
  });

  it("event polarity and the entry check of every event known at t", () => {
    const feature = (v: AsOfView, code: string, t: number) =>
      v
        .events(code, t)
        .map((e) => [
          eventPolarityAt(v, code, t, e, facts.get(e.id)),
          eventEntryCheck(v, code, t, e, facts.get(e.id)),
        ]);
    assertTruncationInvariant(world, feature, { codes });
  });

  it("cold start", () => {
    assertTruncationInvariant(
      world,
      (v, _code, t) => coldStartAt(v, t, { goLiveD: SESSIONS[2]! }, false),
      { codes: ["ZZE"] },
    );
  });

  it("the helper really sees a look-ahead: a feature that peeks at t + 1 fails", () => {
    const peek = (v: AsOfView, code: string, t: number) =>
      t + 1 <= v.maxT ? v.bars(code, t + 1, 1).length : -1;
    expect(truncationMismatches(world, peek, { codes: ["ZZE"] }).length).toBeGreaterThan(0);
  });

  it("the fixtures exercise every state (not a vacuous pass)", () => {
    const view = buildAsOfView(world);
    const seen = new Set<string>();
    for (let t = 0; t < SESSIONS.length; t += 1) {
      for (const code of ["ZZE", "ZZH", "ZZD"])
        seen.add(`ca:${corpActionStateAt(view, code, t).next.state}`);
      seen.add(`halt:${haltStateAt(view, "ZZM", t, undefined, haltInput).next.state}`);
      seen.add(`promo:${promotionStateAt(view, "ZZV", t, undefined, promoInput).next.state}`);
    }
    for (const s of [
      "ca:none",
      "ca:candidate",
      "ca:confirmed",
      "ca:disconfirmed",
      "halt:none",
      "halt:halt",
      "halt:suspension",
      "promo:none",
      "promo:move_block",
      "promo:flagged",
    ]) {
      expect(seen.has(s), s).toBe(true);
    }
  });
});
