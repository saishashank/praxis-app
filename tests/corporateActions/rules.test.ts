// @vitest-environment node
// Corporate action rules (M2 T8): DAT-220..223, AT-08 known-answer goldens, the 5-session rule
// (DAT-221). Pure functions, synthetic data only (SEC-110). Factors are exact rationals; the
// goldens compare the exact fraction and a fixed 12-decimal string (hand-computed below).
import { describe, expect, it } from "vitest";
import {
  autoApplyDate,
  autoApplyDue,
  canonicalJson,
  classOf,
  describeTerms,
  entitlementCompensation,
  evaluateGroup,
  evidenceScore,
  factorFor,
  inferRatio,
  isEffective,
  isUnresolved,
  parseNote,
  payloadProblem,
  pickBestEvidence,
  priceConsistent,
  ratio,
  ratioMul,
  ratioToDecimal,
  ratioToNumber,
  reasonText,
  sessionsElapsed,
  stateOf,
  typeLabel,
  TYPES,
  validateCandidate,
} from "@/lib/data/corporateActions/rules.mjs";

const dec = (type: string, payload: unknown, places = 12) => {
  const f = factorFor(type, payload);
  return f === null ? null : ratioToDecimal(f, places);
};

describe("AT-08 goldens: adjustment factor per type (exact)", () => {
  // factor f: adjusted = raw x f for bars before the ex-date. Hand-computed, not derived.
  it.each([
    ["split 2-for-1 (1 old becomes 2 new)", "split", { new: 2, old: 1 }, "1/2", "0.500000000000"],
    ["split 5-for-1", "split", { new: 5, old: 1 }, "1/5", "0.200000000000"],
    ["split 3-for-2", "split", { new: 3, old: 2 }, "2/3", "0.666666666667"],
    ["split 10-for-1", "split", { new: 10, old: 1 }, "1/10", "0.100000000000"],
    ["consolidation 1-for-10", "consolidation", { new: 1, old: 10 }, "10", "10.000000000000"],
    ["consolidation 2-for-5", "consolidation", { new: 2, old: 5 }, "5/2", "2.500000000000"],
    ["consolidation 1-for-3", "consolidation", { new: 1, old: 3 }, "3", "3.000000000000"],
    ["bonus 1-for-4", "bonus_issue", { new: 1, old: 4 }, "4/5", "0.800000000000"],
    ["bonus 1-for-1", "bonus_issue", { new: 1, old: 1 }, "1/2", "0.500000000000"],
    ["bonus 2-for-5", "bonus_issue", { new: 2, old: 5 }, "5/7", "0.714285714286"],
  ])("%s", (_n, type, payload, frac, decimal) => {
    const f = factorFor(type, payload)!;
    expect(`${f.n}${f.d === 1n ? "" : `/${f.d}`}`).toBe(frac);
    expect(ratioToDecimal(f, 12)).toBe(decimal);
  });

  it.each([
    "cash_dividend",
    "special_dividend",
    "rights_renounceable",
    "rights_non_renounceable",
    "merger_cash",
    "merger_scrip",
    "code_change",
    "delisting",
  ])("%s does not adjust prices (factor 1; cash effects are the simulator's)", (type) => {
    expect(dec(type, {})).toBe("1.000000000000");
    expect(ratioToNumber(factorFor(type, {})!)).toBe(1);
  });

  it("spin-off adjusts only with a stated retained fraction; otherwise unknown", () => {
    expect(dec("spin_off", { retained: { num: 3, den: 4 } })).toBe("0.750000000000");
    expect(factorFor("spin_off", {})).toBeNull();
  });

  it("the stored REAL is the nearest double to the exact fraction", () => {
    expect(ratioToNumber(factorFor("split", { new: 2, old: 1 })!)).toBe(0.5);
    expect(ratioToNumber(factorFor("split", { new: 3, old: 2 })!)).toBe(2 / 3);
    expect(ratioToNumber(factorFor("bonus_issue", { new: 2, old: 5 })!)).toBe(5 / 7);
    expect(ratioToNumber(factorFor("consolidation", { new: 1, old: 10 })!)).toBe(10);
  });

  it("a 2-for-1 split leaves no artificial P/L: 100 sh at 10.00 -> 200 sh at 5.00", () => {
    const f = factorFor("split", { new: 2, old: 1 })!;
    const preClose = 10;
    const adjustedPre = preClose * ratioToNumber(f);
    expect(adjustedPre).toBe(5); // equals the post-split raw close of an unchanged stock
    expect(100 * preClose).toBe(200 * adjustedPre); // position value is continuous
  });

  it("a consolidation 1-for-10 leaves no artificial P/L: 1000 sh at 0.50 -> 100 sh at 5.00", () => {
    const f = factorFor("consolidation", { new: 1, old: 10 })!;
    expect(0.5 * ratioToNumber(f)).toBe(5);
    expect(1000 * 0.5).toBe(100 * 0.5 * ratioToNumber(f));
  });

  it("factors compose exactly: split 2-for-1 then consolidation 1-for-4", () => {
    const f = ratioMul(
      factorFor("split", { new: 2, old: 1 })!,
      factorFor("consolidation", { new: 1, old: 4 })!,
    );
    expect(ratioToDecimal(f)).toBe("2.000000000000");
  });
});

describe("exact rational helpers", () => {
  it("normalises and rejects non-positive parts", () => {
    expect(ratio(4, 8)).toEqual({ n: 1n, d: 2n });
    expect(() => ratio(0, 1)).toThrow(RangeError);
    expect(() => ratio(1, 0)).toThrow(RangeError);
  });
  it("renders fixed decimals, half up", () => {
    expect(ratioToDecimal(ratio(1, 3), 12)).toBe("0.333333333333");
    expect(ratioToDecimal(ratio(2, 3), 12)).toBe("0.666666666667");
    expect(ratioToDecimal(ratio(1, 2), 0)).toBe("1");
    expect(ratioToDecimal(ratio(1, 1_000_000), 12)).toBe("0.000001000000");
    expect(ratioToDecimal(ratio(5, 1), 2)).toBe("5.00");
  });
  it("falls back to the decimal text for parts above 2^53", () => {
    const big = ratio(10n ** 20n, 3n * 10n ** 19n);
    expect(ratioToNumber(big)).toBeCloseTo(10 / 3, 12);
  });
});

describe("payloads and candidates (DAT-220)", () => {
  it("lists the DAT-220 types and groups split/consolidation/bonus into one class", () => {
    expect(TYPES).toHaveLength(12);
    expect(classOf("split")).toBe("price");
    expect(classOf("bonus_issue")).toBe("price");
    expect(classOf("cash_dividend")).toBe("cash_dividend");
  });
  it.each([
    ["split", { new: 1, old: 2 }, "split_needs_more_shares"],
    ["split", { new: 2, old: 2 }, "split_needs_more_shares"],
    ["consolidation", { new: 10, old: 1 }, "consolidation_needs_fewer_shares"],
    ["split", { new: 2.5, old: 1 }, "ratio_invalid"],
    ["split", { new: 0, old: 1 }, "ratio_invalid"],
    ["bonus_issue", { new: 1 }, "ratio_invalid"],
    ["split", { new: 2_000_000, old: 1 }, "ratio_invalid"],
    ["spin_off", { retained: { num: 5, den: 4 } }, "retained_invalid"],
    ["split", [], "payload_not_object"],
    ["cash_dividend", { note: "x".repeat(2100) }, "payload_too_large"],
  ])("%s %j is refused: %s", (type, payload, reason) => {
    expect(payloadProblem(type, payload)).toBe(reason);
  });
  it("accepts good payloads", () => {
    expect(payloadProblem("split", { new: 2, old: 1 })).toBeNull();
    expect(payloadProblem("consolidation", { new: 1, old: 10 })).toBeNull();
    expect(payloadProblem("spin_off", { retained: { num: 3, den: 4 } })).toBeNull();
    expect(payloadProblem("cash_dividend", { amount: "0.25" })).toBeNull();
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,2]},"b":1}',
    );
  });
  it("validates candidates", () => {
    const ok = validateCandidate({
      code: "ZZA",
      type: "split",
      ex_date: "2026-10-13",
      payload: { old: 1, new: 2 },
      source: "announcement",
      ref: "ann-1",
    });
    expect(ok).toMatchObject({
      ok: true,
      value: { payload: { new: 2, old: 1 }, record_date: null },
    });
    const base = { code: "ZZA", type: "code_change", ex_date: "2026-10-13", source: "vendor" };
    for (const [bad, reason] of [
      [null, "not_object"],
      [{ ...base, code: "zz" }, "bad_code"],
      [{ ...base, type: "nope" }, "bad_type"],
      [{ ...base, ex_date: "2026-13-13" }, "bad_ex_date"],
      [{ ...base, record_date: "x" }, "bad_date"],
      [{ ...base, source: "web" }, "bad_source"],
      [{ ...base, type: "split", payload: {} }, "ratio_invalid"],
    ] as const) {
      expect(validateCandidate(bad)).toEqual({ ok: false, reason });
    }
  });
});

describe("DAT-223 entitlement offers are not taken up", () => {
  const rights = { rights: { new: 1, old: 2 } };
  it("non-renounceable: no compensation", () => {
    expect(
      entitlementCompensation("rights_non_renounceable", { ...rights, last_price_cents: 15 }).n,
    ).toBe(0n);
  });
  it("renounceable: rights at their last traded price per share held, else zero", () => {
    // 1 right per 2 shares, last traded 15 cents: 0.075 dollars per share held = 3/40
    const c = entitlementCompensation("rights_renounceable", { ...rights, last_price_cents: 15 });
    expect(c).toEqual({ n: 3n, d: 40n });
    expect(ratioToDecimal(c as { n: bigint; d: bigint }, 3)).toBe("0.075");
    expect(entitlementCompensation("rights_renounceable", rights).n).toBe(0n); // untraded
    expect(
      entitlementCompensation("rights_renounceable", { ...rights, last_price_cents: 0 }).n,
    ).toBe(0n);
    expect(entitlementCompensation("rights_renounceable", { last_price_cents: 15 }).n).toBe(0n);
    expect(entitlementCompensation("rights_renounceable", undefined).n).toBe(0n);
  });
});

describe("price evidence", () => {
  const half = ratio(1, 2);
  it("a 2-for-1 split halves the price within the tolerance", () => {
    expect(priceConsistent(0.5, half, 10)).toBe(true);
    expect(priceConsistent(0.54, half, 10)).toBe(true);
    expect(priceConsistent(0.551, half, 10)).toBe(false); // 10.2% off
    expect(priceConsistent(1, half, 10)).toBe(false);
    expect(priceConsistent(NaN, half, 10)).toBe(false);
    expect(priceConsistent(-1, half, 10)).toBe(false);
  });
  it("infers a clean whole-number split or consolidation, else nothing", () => {
    expect(inferRatio(0.5, 10)).toEqual({ type: "split", payload: { new: 2, old: 1 } });
    expect(inferRatio(0.2, 10)).toEqual({ type: "split", payload: { new: 5, old: 1 } });
    expect(inferRatio(0.52, 10)).toEqual({ type: "split", payload: { new: 2, old: 1 } });
    expect(inferRatio(10.4, 10)).toEqual({ type: "consolidation", payload: { new: 1, old: 10 } });
    expect(inferRatio(0.7, 10)).toBeNull();
    expect(inferRatio(0.4, 10)).toBeNull();
    expect(inferRatio(1.2, 10)).toBeNull();
    expect(inferRatio(1000, 10)).toBeNull();
    expect(inferRatio(0.001, 10)).toBeNull();
    expect(inferRatio(0, 10)).toBeNull();
    expect(inferRatio(Infinity, 10)).toBeNull();
  });
});

describe("DAT-221 evaluation of a group", () => {
  const split = (id: number, n: number, o: number, sources: string[]) => ({
    id,
    type: "split",
    payload: { new: n, old: o },
    sources,
  });
  const drop = { prevClose: 10, exClose: 5.1 };
  it("a single source consistent with the price is auto-confirmed", () => {
    const r = evaluateGroup({ actions: [split(1, 2, 1, ["announcement"])], price: drop });
    expect(r).toMatchObject({
      pending: false,
      decisions: [{ id: 1, outcome: "auto_confirm", reasons: [] }],
    });
    const r2 = evaluateGroup({ actions: [split(1, 2, 1, ["vendor"])], price: drop });
    expect(r2).toMatchObject({ decisions: [{ outcome: "auto_confirm" }] });
  });
  it("announcement and vendor with the same terms and a matching price are auto-confirmed", () => {
    const r = evaluateGroup({ actions: [split(1, 2, 1, ["announcement", "vendor"])], price: drop });
    expect(r).toMatchObject({ decisions: [{ outcome: "auto_confirm", score: 100 + 10 + 5 }] });
  });
  it("a price that contradicts the terms is a conflict", () => {
    const r = evaluateGroup({
      actions: [split(1, 2, 1, ["announcement"])],
      price: { prevClose: 10, exClose: 10 },
    });
    expect(r).toMatchObject({
      decisions: [{ outcome: "conflict", reasons: ["price_mismatch"], score: 10 }],
    });
  });
  it("different terms from two sources conflict; the better-supported one scores higher", () => {
    const r = evaluateGroup({
      actions: [split(1, 2, 1, ["announcement"]), split(2, 3, 1, ["vendor"])],
      price: drop,
    });
    expect(r).toMatchObject({
      decisions: [
        { id: 1, outcome: "conflict", score: 110, reasons: ["sources_disagree"] },
        { id: 2, outcome: "conflict", score: 5, reasons: ["sources_disagree", "price_mismatch"] },
      ],
    });
  });
  it("a price jump with no other source is an unexplained jump (always a conflict)", () => {
    const r = evaluateGroup({ actions: [split(1, 2, 1, ["price"])], price: drop });
    expect(r).toMatchObject({
      decisions: [{ outcome: "conflict", reasons: ["unexplained_jump"], score: 101 }],
    });
  });
  it("an action already confirmed for the date makes a new reading a conflict", () => {
    const r = evaluateGroup({
      actions: [split(2, 2, 1, ["vendor"])],
      price: drop,
      hasEffective: true,
    });
    expect(r).toMatchObject({
      decisions: [{ outcome: "conflict", reasons: ["conflicts_with_confirmed"] }],
    });
  });
  it("a price-type action waits (pending) until the ex-date bar is stored", () => {
    expect(evaluateGroup({ actions: [split(1, 2, 1, ["announcement"])], price: null })).toEqual({
      pending: true,
    });
  });
  it("types that do not adjust prices need no price check", () => {
    const r = evaluateGroup({
      actions: [
        { id: 1, type: "cash_dividend", payload: { amount: "0.25" }, sources: ["announcement"] },
      ],
      price: null,
    });
    expect(r).toMatchObject({
      pending: false,
      observed: null,
      decisions: [{ outcome: "auto_confirm" }],
    });
  });
  it("a spin-off without a stated fraction always goes to the Owner", () => {
    const r = evaluateGroup({
      actions: [{ id: 1, type: "spin_off", payload: {}, sources: ["announcement"] }],
      price: null,
    });
    expect(r).toMatchObject({ decisions: [{ outcome: "conflict", reasons: ["factor_unknown"] }] });
  });
  it("scores: price-consistent 100, announcement 10, vendor 5, price 1; duplicates count once", () => {
    expect(evidenceScore(["announcement", "announcement", "vendor"], true)).toBe(115);
    expect(evidenceScore(["price"], false)).toBe(1);
    expect(evidenceScore(["unknown"], false)).toBe(0);
  });
  it("best evidence: highest score, then lowest id", () => {
    expect(
      pickBestEvidence([
        { id: 3, score: 10 },
        { id: 2, score: 110 },
        { id: 1, score: 110 },
      ]),
    ).toEqual({ id: 1, score: 110 });
    expect(pickBestEvidence([])).toBeNull();
  });
});

describe("state from the newest event", () => {
  const s = (status: string, note: unknown = null) =>
    stateOf({ status, note: note === null ? null : JSON.stringify(note) });
  it("maps every status", () => {
    expect(stateOf(null).state).toBe("none");
    expect(s("queued", { d: "2026-10-12", queue: "pending" })).toEqual({
      state: "pending",
      d: "2026-10-12",
    });
    expect(s("queued", { queue: "owner" }).state).toBe("owner");
    expect(s("queued", { queue: "blocked" }).state).toBe("blocked");
    expect(s("queued").state).toBe("owner"); // unreadable queue kind: show the Owner
    expect(s("auto_confirmed").state).toBe("confirmed");
    expect(s("applied_best_evidence").state).toBe("confirmed");
    expect(s("resolved", { resolution: "confirmed" }).state).toBe("confirmed");
    expect(s("resolved", { resolution: "rejected" }).state).toBe("rejected");
    expect(s("resolved", { resolution: "superseded" }).state).toBe("rejected");
    expect(s("resolved", { resolution: "reversed" }).state).toBe("reversed");
    expect(s("resolved").state).toBe("rejected");
    expect(s("weird").state).toBe("rejected");
  });
  it("tolerates unreadable notes", () => {
    expect(parseNote("not json")).toEqual({});
    expect(parseNote("[1]")).toEqual({});
    expect(parseNote(null)).toEqual({});
    expect(stateOf({ status: "queued", note: "{oops" }).state).toBe("owner");
  });
  it("effective and unresolved sets", () => {
    expect(isEffective("confirmed")).toBe(true);
    for (const x of ["pending", "owner", "blocked", "rejected", "reversed", "none"] as const) {
      expect(isEffective(x)).toBe(false);
    }
    expect(isUnresolved("owner") && isUnresolved("blocked")).toBe(true);
    expect(isUnresolved("pending") || isUnresolved("confirmed")).toBe(false);
  });
});

describe("DAT-221 the 5-session rule", () => {
  const none: { d: string; kind: string }[] = [];
  // 2026-10-12 is a Monday. Sessions after it: Tue 13, Wed 14, Thu 15, Fri 16, Mon 19.
  it("counts trading sessions strictly after the queued date up to today", () => {
    expect(sessionsElapsed("2026-10-12", "2026-10-12", none)).toBe(0);
    expect(sessionsElapsed("2026-10-12", "2026-10-11", none)).toBe(0);
    expect(sessionsElapsed("2026-10-12", "2026-10-13", none)).toBe(1);
    expect(sessionsElapsed("2026-10-12", "2026-10-16", none)).toBe(4);
    expect(sessionsElapsed("2026-10-12", "2026-10-18", none)).toBe(4); // weekend adds none
    expect(sessionsElapsed("2026-10-12", "2026-10-19", none)).toBe(5);
  });
  it("boundary: not due after 4 sessions, due after 5", () => {
    expect(autoApplyDue("2026-10-12", "2026-10-16", none)).toBe(false);
    expect(autoApplyDue("2026-10-12", "2026-10-19", none)).toBe(true);
    expect(autoApplyDue("2026-10-12", "2026-10-20", none)).toBe(true);
  });
  it("a holiday is not a session", () => {
    const rows = [{ d: "2026-10-14", kind: "holiday" }];
    expect(autoApplyDue("2026-10-12", "2026-10-19", rows)).toBe(false); // only 4 sessions
    expect(autoApplyDue("2026-10-12", "2026-10-20", rows)).toBe(true);
  });
  it("queued on a weekend or Friday night counts from the next session", () => {
    expect(sessionsElapsed("2026-10-16", "2026-10-23", none)).toBe(5);
    expect(sessionsElapsed("2026-10-17", "2026-10-23", none)).toBe(5);
  });
  it("the number of sessions is a setting", () => {
    expect(autoApplyDue("2026-10-12", "2026-10-14", none, 2)).toBe(true);
    expect(autoApplyDue("2026-10-12", "2026-10-13", none, 2)).toBe(false);
  });
  it("names the date it falls due", () => {
    expect(autoApplyDate("2026-10-12", none)).toBe("2026-10-19");
    expect(autoApplyDate("2026-10-12", [{ d: "2026-10-14", kind: "holiday" }])).toBe("2026-10-20");
    expect(autoApplyDate("2026-10-12", none, 2)).toBe("2026-10-14");
  });
});

describe("plain-language text (UX-114)", () => {
  it("labels types and terms", () => {
    expect(typeLabel("split")).toBe("share split");
    expect(typeLabel("mystery")).toBe("mystery");
    expect(describeTerms("split", { new: 2, old: 1 })).toBe("1 old share(s) become 2 new share(s)");
    expect(describeTerms("bonus_issue", { new: 1, old: 4 })).toBe(
      "1 new share(s) free for every 4 held",
    );
    expect(describeTerms("cash_dividend", {})).toBe("no price adjustment");
    expect(reasonText("price_mismatch")).toMatch(/does not match/);
    expect(reasonText("zzz")).toBe("zzz");
  });
});
