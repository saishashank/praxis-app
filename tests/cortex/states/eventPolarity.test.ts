// @vitest-environment node
// CTX-043 event polarity and the U2/U3 D+2 entry rule (M15 C3b; AT-56 fixtures 1 "claimed notice,
// no entry" and 2 "keyword-only title -> polarity 0").
import { describe, expect, it } from "vitest";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import {
  eventEntryCheck,
  eventPolarityAt,
  polarityThreshold,
  returnSigma,
  verifiable,
} from "@/lib/cortex/states/eventPolarity";
import { DEFAULT_STATES_PARAMS } from "@/lib/cortex/states/types";
import { makeRational } from "@/lib/money/rational";
import { eventAt, path, pct, SESSIONS, statesWorld, type FixtureSpec } from "./zzStates";

const DAY0 = 25;
const D0 = SESSIONS[DAY0]!;

describe("fixture 1: a U2 contract notice with a named party but no value is `claimed`", () => {
  const ev = eventAt("ZZS", D0, "contract_win", 1, pct(10));
  const spec: FixtureSpec = {
    code: "ZZS",
    tier: "U2",
    bars: { closesCents: path(1000, DAY0, [0.1]) },
    events: [ev],
  };
  const view = buildAsOfView(statesWorld([spec]));

  it("polarity 0, label claimed, whatever the move", () => {
    const r = eventPolarityAt(view, "ZZS", DAY0, ev, { hasCounterparty: true });
    expect(r).toMatchObject({
      polarity: 0,
      label: "claimed",
      reason: "category_contract_win_claimed",
    });
    expect(eventPolarityAt(view, "ZZS", DAY0, ev, { hasValue: true }).label).toBe("claimed");
    expect(eventPolarityAt(view, "ZZS", DAY0, ev, {}).label).toBe("claimed");
  });

  it("no entry: a U2 contract is never an entry, even with value and counterparty", () => {
    const claimed = eventEntryCheck(view, "ZZS", DAY0 + 2, ev, { hasCounterparty: true });
    expect(claimed).toEqual({
      eligible: false,
      stage: "d2",
      label: "for a smaller company only results or guidance with parsed figures can start a trade",
      reason: "u23_category_not_entry",
    });
    const full = eventPolarityAt(view, "ZZS", DAY0, ev, { hasValue: true, hasCounterparty: true });
    expect(full).toMatchObject({ polarity: 1, label: "verified" });
    expect(
      eventEntryCheck(view, "ZZS", DAY0 + 2, ev, { hasValue: true, hasCounterparty: true })
        .eligible,
    ).toBe(false);
  });
});

describe("fixture 2: a keyword-only title has polarity 0", () => {
  const spec: FixtureSpec = {
    code: "ZZT",
    tier: "U1",
    bars: { closesCents: path(1000, DAY0, [0.005]) },
  };
  const view = buildAsOfView(statesWorld([spec]));

  it("results keyword with a move below max(2 %, 1.5 sigma) -> 0 / no_move", () => {
    const small = eventAt("ZZT", D0, "results", 1, pct(0.5));
    expect(eventPolarityAt(view, "ZZT", DAY0, small)).toMatchObject({
      polarity: 0,
      label: "no_move",
      reason: "ar0_below_threshold",
    });
    const noAr = eventAt("ZZT", D0, "results", 1, null);
    expect(eventPolarityAt(view, "ZZT", DAY0, noAr)).toMatchObject({
      polarity: 0,
      label: "no_move",
      reason: "no_ar0",
    });
    expect(eventPolarityAt(view, "ZZT", DAY0, small).threshold).toEqual(
      makeRational(2_000_000n, 100_000_000n),
    );
  });

  it("a verifiable keyword with a consistent move is verified; against the keyword it is 0", () => {
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "results", 1, pct(5))),
    ).toMatchObject({ polarity: 1, label: "verified" });
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "results", 1, pct(-5))).polarity,
    ).toBe(-1);
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "guidance_up", 1, pct(-5))),
    ).toMatchObject({ polarity: 0, label: "inconsistent" });
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "guidance_down", -1, pct(-5))).polarity,
    ).toBe(-1);
  });

  it("non-verifiable categories and non-binding takeovers are `other`", () => {
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "management_change", 1, pct(9))),
    ).toMatchObject({ polarity: 0, label: "other" });
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "takeover_target", 1, pct(20))),
    ).toMatchObject({ polarity: 0, label: "other" });
    expect(
      eventPolarityAt(view, "ZZT", DAY0, eventAt("ZZT", D0, "takeover_target", 1, pct(20)), {
        binding: true,
      }).polarity,
    ).toBe(1);
    expect(verifiable("capital_raising", {})).toBe("other");
    expect(verifiable("contract_win", { hasValue: true, hasCounterparty: true })).toBe("ok");
  });

  it("the threshold scales with the code's 60-session return sd", () => {
    // closes alternate +-3 % a session: sd about 3.1 %, so the threshold is about 4.6 %, above the 2 % floor
    const wobble = Array.from({ length: SESSIONS.length }, (_, i) => (i % 2 === 0 ? 1000 : 1030));
    const v = buildAsOfView(
      statesWorld([{ code: "ZZW", tier: "U1", bars: { closesCents: wobble } }]),
    );
    const sigma = returnSigma(v, "ZZW", DAY0 - 1, 60)!;
    expect(sigma).toBeGreaterThan(0.029);
    expect(sigma).toBeLessThan(0.032);
    const thr = polarityThreshold(sigma, DEFAULT_STATES_PARAMS);
    expect(Number(thr.num) / Number(thr.den)).toBeCloseTo(sigma * 1.5, 9);
    expect(eventPolarityAt(v, "ZZW", DAY0, eventAt("ZZW", D0, "results", 1, pct(4))).label).toBe(
      "no_move",
    );
    expect(eventPolarityAt(v, "ZZW", DAY0, eventAt("ZZW", D0, "results", 1, pct(5))).label).toBe(
      "verified",
    );
    expect(polarityThreshold(null, DEFAULT_STATES_PARAMS)).toEqual(
      makeRational(2_000_000n, 100_000_000n),
    );
  });
});

describe("U2/U3 entries: results or guidance with parsed figures, on D+2, with EOD persistence", () => {
  const ev = eventAt("ZZU", D0, "results", 1, pct(10));
  const facts = { financialsParsed: true };
  const volumes = SESSIONS.map((_, i) => (i === DAY0 + 1 ? 300_000n : 100_000n));
  const good: FixtureSpec = {
    code: "ZZU",
    tier: "U2",
    bars: { closesCents: path(1000, DAY0, [0.1, 0]), volumes },
    events: [ev],
  };

  it("eligible on D+2 when the D+1 close keeps half of AR0 and D+1 volume >= 2 x ADV20 before day 0", () => {
    const view = buildAsOfView(statesWorld([good]));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 2, ev, facts)).toEqual({
      eligible: true,
      stage: "d2",
      label: "entry on the second session after the notice",
      reason: "u23_d2_persisted",
    });
    expect(eventEntryCheck(view, "ZZU", DAY0 + 1, ev, facts)).toMatchObject({
      eligible: false,
      reason: "u23_not_d2",
    });
    expect(eventEntryCheck(view, "ZZU", DAY0 + 3, ev, facts)).toMatchObject({
      eligible: false,
      reason: "u23_not_d2",
    });
  });

  it("without parsed financials a results release is an observation only", () => {
    const view = buildAsOfView(statesWorld([good]));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 2, ev, {})).toMatchObject({
      eligible: false,
      reason: "u23_financials_not_parsed",
    });
  });

  it("no persistence: the D+1 close gives back more than half of AR0", () => {
    const fade: FixtureSpec = {
      ...good,
      bars: { closesCents: path(1000, DAY0, [0.1, -0.06]), volumes },
    };
    const view = buildAsOfView(statesWorld([fade]));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 2, ev, facts)).toMatchObject({
      eligible: false,
      reason: "u23_no_persistence",
    });
  });

  it("no volume: D+1 notional under 2 x ADV20", () => {
    const thin: FixtureSpec = { ...good, bars: { closesCents: path(1000, DAY0, [0.1, 0]) } };
    const view = buildAsOfView(statesWorld([thin]));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 2, ev, facts)).toMatchObject({
      eligible: false,
      reason: "u23_no_volume",
    });
  });

  it("a U1 code keeps the D+1 entry when the polarity is verified", () => {
    const u1: FixtureSpec = { ...good, tier: "U1" };
    const view = buildAsOfView(statesWorld([u1]));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 1, ev)).toMatchObject({
      eligible: true,
      stage: "d1",
      reason: "u1_d1",
    });
    expect(eventEntryCheck(view, "ZZU", DAY0 + 2, ev)).toMatchObject({
      eligible: false,
      reason: "u1_not_d1",
    });
    const claimed = eventAt("ZZU", D0, "contract_win", 1, pct(10));
    expect(eventEntryCheck(view, "ZZU", DAY0 + 1, claimed)).toMatchObject({
      eligible: false,
      label: "this notice has no verified direction",
    });
  });
});
