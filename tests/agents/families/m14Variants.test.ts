// @vitest-environment node
// M14 WP6: the O-49 F5 universe, the KB-081 structural variants (F1 window / skip-month, F4 5-session
// reversal), AGT-137 day0_ar, the DAT-234 index-change exclusion and AGT-136 director_sale. Every new
// switch defaults to v1 behaviour. Synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import { runFamilies } from "@/lib/agents/families";
import { createContext } from "@/lib/agents/families/context";
import { insiderFlowScore } from "@/lib/agents/insiderFlow";
import type { NoticeRow } from "@/lib/agents/decisionView";
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  CENT,
  DOLLAR,
  SESSIONS,
  dayAgo,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  peers,
  rat,
  rising,
  volumes,
  wobble,
} from "../../fixtures/agents/families/builders";

const p = defaultAgentParams();
const withKeys = (over: Partial<Record<ConfigKey, unknown>>) =>
  buildAgentParams((k) => (k in over ? over[k] : CONFIG_KEYS[k].default));
const has = (out: ReturnType<typeof runFamilies>, family: string) =>
  out.candidates.some((c) => c.family === family);

// ---- O-49: F5 trades U2 only; U3 is a replay-only stress variant -------------------------------------------

describe("F5 universe (O-49, D-221)", () => {
  const small = (tier: "U1" | "U2" | "U3", code = "ZZS") =>
    factsOf(
      code,
      tier,
      makeBars({
        close: () => DOLLAR,
        volume: volumes(1_000_000n, 4_000_000n),
        spread: 2n * CENT,
        last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n },
      }),
      p,
    );
  const e = (code: string) =>
    ev({ code, category: "contract_win", polarity: 1, ar: "0.05", vol: "4" });

  it("defaults to U2: a U2 code enters, a U3 code does not", () => {
    expect(has(runFamilies(inputsOf([small("U2")], { events: [e("ZZS")] }), p), "F5")).toBe(true);
    const u3 = runFamilies(inputsOf([small("U3")], { events: [e("ZZS")] }), p);
    expect(has(u3, "F5")).toBe(false);
    expect(u3.blocked.some((b) => b.family === "F5")).toBe(false);
  });

  it("f5_default_universe picks the tier", () => {
    const u3 = withKeys({ f5_default_universe: "U3" });
    expect(has(runFamilies(inputsOf([small("U3")], { events: [e("ZZS")] }), u3), "F5")).toBe(true);
    expect(has(runFamilies(inputsOf([small("U2")], { events: [e("ZZS")] }), u3), "F5")).toBe(false);
  });

  it("f5StressU3 emits the U3 run as variant F5-U3-stress; U2 stays F5", () => {
    const out = runFamilies(
      inputsOf([small("U3", "ZZT"), small("U2", "ZZS")], { events: [e("ZZS"), e("ZZT")] }),
      p,
      { f5StressU3: true },
    );
    const f5 = out.candidates.filter((c) => c.family === "F5");
    expect(f5.map((c) => [c.code, c.variant]).sort()).toEqual([
      ["ZZS", "F5"],
      ["ZZT", "F5-U3-stress"],
    ]);
  });

  it("the stress run is never F6 evidence", () => {
    const u3 = small("U3", "ZZT");
    const out = runFamilies(inputsOf([override(u3, { tier: "U3" })], { events: [e("ZZT")] }), p, {
      f5StressU3: true,
    });
    expect(out.candidates.filter((c) => c.family === "F5")).toHaveLength(1);
    expect(out.candidates.some((c) => c.family === "F6")).toBe(false);
    expect(out.blocked.some((c) => c.family === "F6")).toBe(false);
  });
});

// ---- KB-081 F1 variants ------------------------------------------------------------------------------------

describe("F1 variants (KB-081)", () => {
  /** A flat for 200 sessions, then +1 cent a session; B rises early and is flat for the last 150. */
  const a = () =>
    factsOf(
      "ZZA",
      "U1",
      makeBars({ close: (i) => (i < 200 ? DOLLAR : DOLLAR + BigInt(i - 199) * CENT) }),
      p,
    );
  const b = () =>
    factsOf(
      "ZZB",
      "U1",
      makeBars({ close: (i) => DOLLAR + BigInt(Math.min(i, 150)) * 2n * CENT }),
      p,
    );
  const pct = (params: ReturnType<typeof withKeys>, code: string) =>
    createContext(inputsOf([a(), b()]), params).f1Percentile.get(code);

  it("v1 settings reuse the v1 percentile map exactly", () => {
    const ctx = createContext(inputsOf([a(), b()]), p);
    expect(ctx.f1Percentile).toBe(ctx.returnPercentile);
  });

  it("a 252-session window ranks B (early riser) above A; 126 ranks A above B", () => {
    expect(pct(p, "ZZA")).toEqual(rat("1"));
    expect(pct(p, "ZZB")).toEqual(rat("0"));
    const w = withKeys({ f1_return_window_sessions: 252 });
    expect(pct(w, "ZZA")).toEqual(rat("0"));
    expect(pct(w, "ZZB")).toEqual(rat("1"));
  });

  it("skip_month_u2 drops the last 21 sessions from the return", () => {
    const late = factsOf(
      "ZZL",
      "U2",
      makeBars({ close: (i) => (i < 279 ? DOLLAR : DOLLAR + BigInt(i - 278) * 50n * CENT) }),
      p,
    );
    const early = factsOf(
      "ZZM",
      "U2",
      makeBars({ close: (i) => DOLLAR + BigInt(Math.min(i, 200)) * CENT }),
      p,
    );
    const skip = withKeys({ f1_momentum_variant: "skip_month_u2" });
    const v1 = createContext(inputsOf([late, early]), p).f1Percentile;
    const sk = createContext(inputsOf([late, early]), skip).f1Percentile;
    expect(v1.get("ZZL")).toEqual(rat("1")); // the late burst counts in v1
    expect(sk.get("ZZL")).toEqual(rat("0")); // and is skipped here
    expect(sk.get("ZZM")).toEqual(rat("1"));
  });

  it("skip_month_u2 trades U2 only: a U2 leader enters without the opt-in, a U1 leader does not", () => {
    const skip = withKeys({ f1_momentum_variant: "skip_month_u2" });
    const world = (tier: "U1" | "U2") => {
      const leader = factsOf(
        "ZZA",
        tier,
        makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
        p,
      );
      return inputsOf([leader, ...peers("ZZP", tier, 9, p)]);
    };
    const u2 = runFamilies(world("U2"), skip);
    expect(u2.candidates.filter((c) => c.family === "F1").map((c) => c.code)).toEqual(["ZZA"]);
    expect(has(runFamilies(world("U1"), skip), "F1")).toBe(false);
    // v1 settings: neither without the opt-in tier
    expect(has(runFamilies(world("U2"), p), "F1")).toBe(false);
  });
});

// ---- KB-081 F4 reversal5_u2 --------------------------------------------------------------------------------

describe("F4 reversal5_u2 (KB-081)", () => {
  const N = 300;
  /** Uptrend, then three sharp down days at the end (a 12 % fall over five sessions). */
  const fall = (i: number): bigint => {
    const base = rising(CENT)(Math.min(i, N - 4));
    const k = BigInt(Math.max(0, i - (N - 4)));
    return (base * (100n - 4n * k)) / 100n;
  };
  const code = (tier: "U1" | "U2") => factsOf("ZZD", tier, makeBars({ close: fall }), p);
  const rev = withKeys({ f4_entry_variant: "reversal5_u2" });

  it("v1 never trades a U2 code", () => {
    const out = runFamilies(inputsOf([code("U2")]), p);
    expect(out.candidates.some((c) => c.family === "F4")).toBe(false);
    expect(out.blocked.some((c) => c.family === "F4")).toBe(false);
  });

  it("the variant takes a U2 code with a 5-session fall of 10 % or more (U1 is not traded)", () => {
    const u2 = runFamilies(inputsOf([code("U2")]), rev);
    const f4 = [...u2.candidates, ...u2.blocked].filter((c) => c.family === "F4");
    expect(f4).toHaveLength(1);
    expect(f4[0]!.rules.find((r) => r.id === "oversold")!.pass).toBe(true);
    expect(f4[0]!.rank[0]).not.toBeNull();
    const u1 = runFamilies(inputsOf([code("U1")]), rev);
    expect([...u1.candidates, ...u1.blocked].some((c) => c.family === "F4")).toBe(false);
  });

  it("a fall under 10 % does not qualify", () => {
    const mild = factsOf(
      "ZZD",
      "U2",
      makeBars({ close: (i) => (i < N - 5 ? rising(CENT)(i) : (rising(CENT)(i) * 97n) / 100n) }),
      p,
    );
    const out = runFamilies(inputsOf([mild]), rev);
    const f4 = [...out.candidates, ...out.blocked].filter((c) => c.family === "F4");
    expect(f4).toHaveLength(0);
  });
});

// ---- AGT-137 day0_ar ---------------------------------------------------------------------------------------

describe("F3 day0_ar surprise (AGT-137, D-243)", () => {
  const code = () => factsOf("ZZE", "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
  const other = (over: Partial<Parameters<typeof ev>[0]> = {}) =>
    ev({ code: "ZZE", category: "other", polarity: 1, ar: "0.05", vol: "3", ...over });
  const mode = withKeys({ f3_surprise_mode: "day0_ar" });

  it("a price-sensitive event outside the v1 category list enters only in day0_ar mode", () => {
    const inputs = inputsOf([code()], { events: [other()] });
    expect(has(runFamilies(inputs, p), "F3")).toBe(false);
    expect(has(runFamilies(inputs, mode), "F3")).toBe(true);
  });

  it("still needs AR >= the F3 minimum, volume, price sensitivity and no negative member", () => {
    const run = (e: ReturnType<typeof other>) =>
      has(runFamilies(inputsOf([code()], { events: [e] }), mode), "F3");
    expect(run(other({ ar: "0.0399" }))).toBe(false);
    expect(run(other({ vol: "1.99" }))).toBe(false);
    expect(run(other({ priceSensitive: false }))).toBe(false);
    expect(run(other({ polarity: -1 }))).toBe(false);
  });

  it("v1 categories behave as before in either mode", () => {
    const e = ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.04", vol: "2" });
    expect(has(runFamilies(inputsOf([code()], { events: [e] }), p), "F3")).toBe(true);
    expect(has(runFamilies(inputsOf([code()], { events: [e] }), mode), "F3")).toBe(true);
  });
});

// ---- DAT-234 index-change exclusion ------------------------------------------------------------------------

describe("F3 index-change exclusion (DAT-234, D-238)", () => {
  const event = () => ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.04", vol: "2" });
  const withChange = (change: { announced: string | null; effective: string }) =>
    override(factsOf("ZZE", "U1", makeBars({ close: wobble(2n * DOLLAR) }), p), {
      indexChanges: [{ indexName: "S&P/ASX 200", kind: "add", ...change }],
    });
  const run = (change: { announced: string | null; effective: string } | null) => {
    const base = factsOf("ZZE", "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
    return runFamilies(
      inputsOf([change === null ? base : withChange(change)], { events: [event()] }),
      p,
    );
  };
  const lastDay = SESSIONS[SESSIONS.length - 1]!; // Friday 2026-10-16

  it("no index change: the event enters", () => {
    expect(has(run(null), "F3")).toBe(true);
  });

  it("effective on day 0 blocks with reason index_change and tags the card", () => {
    const out = run({ announced: dayAgo(10), effective: lastDay });
    expect(has(out, "F3")).toBe(false);
    const b = out.blocked.find((x) => x.family === "F3")!;
    expect(b.reasons).toEqual(["index_change"]);
    expect(b.flags).toContain("index_change:S&P/ASX 200");
  });

  it("announced the session before day 0 blocks; announced two sessions before does not", () => {
    expect(has(run({ announced: dayAgo(1), effective: "2026-12-18" }), "F3")).toBe(false);
    expect(has(run({ announced: dayAgo(2), effective: "2026-12-18" }), "F3")).toBe(true);
  });

  it("effective on the next session (a Monday) blocks; three sessions on does not", () => {
    expect(has(run({ announced: dayAgo(3), effective: "2026-10-19" }), "F3")).toBe(false);
    expect(has(run({ announced: dayAgo(3), effective: "2026-10-21" }), "F3")).toBe(true);
  });

  it("a change not announced by D is invisible (replay = live)", () => {
    expect(has(run({ announced: "2026-10-17", effective: "2026-10-19" }), "F3")).toBe(true);
    expect(has(run({ announced: null, effective: "2026-10-19" }), "F3")).toBe(true);
  });

  it("the window is index_change_window_sessions", () => {
    const wide = withKeys({ index_change_window_sessions: 3 });
    const change = { announced: dayAgo(3), effective: "2026-10-21" };
    const out = runFamilies(inputsOf([withChange(change)], { events: [event()] }), wide);
    expect(has(out, "F3")).toBe(false);
  });
});

// ---- AGT-136 director_sale ---------------------------------------------------------------------------------

describe("insider director_sale weight (AGT-136, D-242)", () => {
  const n = (kind: string): NoticeRow => ({
    ann_id: kind,
    kind,
    value_micro: 5_000_000n,
    published_at: "2026-10-01T01:00:00.000Z",
  });
  const weights = (extra: Record<string, number>) =>
    withKeys({
      insider_score_weights: {
        ...(CONFIG_KEYS.insider_score_weights.default as Record<string, number>),
        ...extra,
      },
    });

  it("absent follows director_net: v1 scores are unchanged", () => {
    expect(insiderFlowScore([n("director_sell")], true, p).score_q).toBe(-2);
    expect(p.insiderWeights.directorSale).toEqual(p.insiderWeights.directorNet);
  });

  it("0.25 halves the net-sale penalty and leaves purchases alone", () => {
    const q = weights({ director_sale: 0.25 });
    expect(insiderFlowScore([n("director_sell")], true, q).score_q).toBe(-1);
    expect(insiderFlowScore([n("director_buy")], true, q).score_q).toBe(2);
  });
});
