// @vitest-environment node
// The Decision Card explainer texts (UXN-037, 100, 102, 120 to 123, 126; M7 T13): the "Given ... then"
// criteria of ch.16 as unit tests. Pure functions: fixed templates over a stored card, no LLM, no
// probability, past tense for history.
import { describe, expect, it } from "vitest";
import type { DecisionCard } from "@/lib/agents/cards";
import {
  afterwards,
  basedOn,
  checklist,
  evidenceLine,
  factorItems,
  headwinds,
  netPpm,
  pastSetups,
  PAST_ONLY_CAVEAT,
  ruleMargin,
  scenarioRows,
  validationMeaning,
  WHY_LABEL,
  whyLines,
  type FactorBucketRow,
} from "@/lib/ui/loaders/cardParts";
import { hasForbiddenClaim } from "@/lib/view/honesty";

const id = (s: string) => s;

function card(over: Partial<DecisionCard> = {}): DecisionCard {
  return {
    v: 1,
    market: "AU",
    d: "2026-10-19",
    code: "ZZUP",
    family: "F4",
    execution: "E01",
    rule_version: "F4.v1",
    variant: "U",
    regime: "RISK-ON",
    taken: true,
    not_taken_reason: null,
    thesis: "Mean reversion: an oversold close above the long-term trend.",
    rules_fired: [
      { rule: "atr_warm", value: "12000", threshold: "ATR warm", pass: true },
      { rule: "close_above_sma_trend", value: "true", threshold: "close > SMA(200)", pass: true },
      { rule: "oversold", value: "9.5", threshold: "< 10", pass: true },
    ],
    rank_score: "1",
    evidence: {
      events: [],
      insider_flow: "unknown",
      short_interest: "unknown",
      data_quality_flags: [],
      other_flags: [],
    },
    thesis_breakers: [],
    exit_plan: [],
    sizing: {
      available: true,
      accepted: true,
      reasons: [],
      qty: "10",
      fill_price_micro: "1000000",
      order_value_micro: "10000000",
      half_size: false,
    },
    cost: {
      available: false,
      reason: "not_sized",
      entry_brokerage_micro: null,
      entry_slippage_micro: null,
      exit_brokerage_micro: null,
      exit_slippage_micro: null,
      cost_estimate_micro: null,
      order_value_micro: null,
      break_even_ppm: null,
    },
    scenario: {
      insufficient_history: false,
      n: 87,
      reason: null,
      p10_ppm: -62_000,
      p50_ppm: 31_000,
      p90_ppm: 114_000,
      split_version: 1,
      as_of_roll_d: "2026-10-16",
      variant: "U",
      rule_version: "F4.v1",
    },
    footnote: "f",
    ...over,
  } as DecisionCard;
}

describe("UXN-120: what past similar setups did", () => {
  it("n = 87: median, 10th/90th range and profitable share with its interval, in the past tense", () => {
    const p = pastSetups(card(), "CONSISTENT-FORWARD", {
      k: 50,
      n: 87,
      lower: 0.49,
      upper: 0.66,
      level: 0.9,
    });
    expect(p.state).toBe("enough");
    expect(p.summary).toContain(
      "In 87 past similar setups the typical result was +3.1% after costs",
    );
    expect(p.summary).toContain("1 in 10 did worse than");
    expect(p.summary).toContain("1 in 10 did better than");
    expect(p.lines[0]).toBe("57% were profitable (90% range 49–66%, n = 87).");
    const all = [p.summary, ...p.lines].join(" ");
    expect(all).not.toMatch(/\bwill\b/i);
    expect(hasForbiddenClaim(all)).toBe(false);
    expect(p.caveat).toBeNull();
  });

  it("n = 12: says so and shows nothing else numeric", () => {
    const c = card({
      scenario: {
        ...card().scenario,
        insufficient_history: true,
        n: 12,
        p10_ppm: null,
        p50_ppm: null,
        p90_ppm: null,
      },
    });
    const p = pastSetups(c, "UNVALIDATED", null);
    expect(p.state).toBe("insufficient");
    expect(p.summary).toBe("Not enough history to say yet (n = 12).");
    expect(p.lines).toEqual([]);
  });

  it("carries the past-data-only caveat for UNVALIDATED and PASSED-BACKTEST (and for no label)", () => {
    for (const l of ["UNVALIDATED", "PASSED-BACKTEST", null]) {
      expect(pastSetups(card(), l, null).caveat).toBe(PAST_ONLY_CAVEAT);
    }
    expect(pastSetups(card(), "CONSISTENT-FORWARD", null).caveat).toBeNull();
  });
});

describe("UXN-121: factor contributions", () => {
  const rows: FactorBucketRow[] = [
    {
      factor: "oversold",
      bucket: 1,
      edges: [5, 8],
      n: 40,
      medianNetPpm: 30_000,
      familyMedianPpm: 10_000,
    },
    {
      factor: "oversold",
      bucket: 2,
      edges: [5, 8],
      n: 14,
      medianNetPpm: 5_000,
      familyMedianPpm: 10_000,
    },
    {
      factor: "oversold",
      bucket: 3,
      edges: [5, 8],
      n: 33,
      medianNetPpm: -20_000,
      familyMedianPpm: 10_000,
    },
    {
      factor: "close_above_sma_trend",
      bucket: 1,
      edges: [0],
      n: 60,
      medianNetPpm: 25_000,
      familyMedianPpm: 10_000,
    },
  ];

  it("a bucket with n = 14 reads 'not enough history' and has no bar", () => {
    const f = factorItems(card(), rows, 30, id); // 9.5 falls in bucket 3? edges 5, 8: 9.5 > 8 -> bucket 3
    // 9.5 is above both edges -> bucket 3 (n = 33, enough). Use a value in bucket 2 for the n = 14 case.
    expect(f.down.map((x) => x.effect)).toEqual(["-3 points"]);
    const c2 = card({
      rules_fired: [{ rule: "oversold", value: "6", threshold: "< 10", pass: true }],
    });
    const g = factorItems(c2, rows, 30, id);
    expect(g.notEnough).toHaveLength(1);
    expect(g.notEnough[0]).toMatchObject({ effect: null, effectPpm: null, barPct: 0, n: 14 });
    expect(g.up).toEqual([]);
    expect(g.down).toEqual([]);
  });

  it("splits into pushing up and pulling down, with a bar relative to the largest effect", () => {
    const c = card({
      rules_fired: [
        { rule: "oversold", value: "9.5", threshold: "< 10", pass: true },
        { rule: "close_above_sma_trend", value: "-1", threshold: "> -5", pass: true },
      ],
    });
    const f = factorItems(c, rows, 30, id);
    expect(f.up.map((x) => x.label)).toEqual(["The share price is above its long-term trend"]);
    expect(f.up[0]!.barPct).toBe(50); // +15,000 ppm against the largest effect, 30,000
    expect(f.down[0]!.effect).toBe("-3 points");
    expect(f.up[0]!.effect).toBe("+1.5 points");
    expect(f.down[0]!.barPct).toBe(100);
  });
});

describe("UXN-122: rule checklist with margins", () => {
  it("RSI 6.1 needed below 10 has margin 3.9", () => {
    expect(ruleMargin("6.1", "< 10", true)).toMatchObject({ margin: 3.9, justMet: false });
  });

  it("RSI 9.5 against 10 is marked 'only just met'", () => {
    const rows = checklist(card(), id);
    const r = rows.find((x) => x.label.includes("fallen sharply"))!;
    expect(r).toMatchObject({
      value: "9.5",
      needed: "below 10",
      margin: "0.5",
      pass: true,
      justMet: true,
    });
  });

  it("a rule that failed is never 'only just met'; non-numeric rules show their stored text", () => {
    expect(ruleMargin("9.9", "< 10", false)?.justMet).toBe(false);
    const rows = checklist(card(), id);
    const trend = rows.find((x) => x.label.includes("long-term trend"))!;
    expect(trend).toMatchObject({ value: "Yes", needed: "close > SMA(200)", margin: null });
    const warm = rows.find((x) => x.label.includes("price history"))!;
    expect(warm).toMatchObject({ value: "Yes", needed: null });
  });

  it("a threshold of zero is never 'just met' and an unknown rule id is passed through the mask", () => {
    expect(ruleMargin("0.1", "> 0", true)?.justMet).toBe(false);
    const rows = checklist(
      card({ rules_fired: [{ rule: "R1_vs_ZZDN", value: "x", threshold: "y", pass: true }] }),
      (s) => s.replace("ZZDN", "Stock B"),
    );
    expect(rows[0]!.label).toBe("R1 vs Stock B");
  });
});

describe("UXN-123: What could hurt this", () => {
  it("an UNVALIDATED strategy with no other caveat still shows the validation label with its meaning", () => {
    const h = headwinds(card(), "UNVALIDATED", [], id);
    expect(h).toEqual([
      { kind: "Evidence", text: "UNVALIDATED — this strategy is not yet proven better than luck" },
    ]);
    expect(validationMeaning(null)).toContain("UNVALIDATED");
  });

  it("lists cost drag, thin trading, amber/red warning signs, flags and little history", () => {
    const c = card({
      cost: { ...card().cost, available: true, break_even_ppm: 15_400 },
      sizing: { ...card().sizing, half_size: true, reasons: ["adv_cap"] },
      evidence: { ...card().evidence, data_quality_flags: ["first_seen"], other_flags: [] },
      scenario: { ...card().scenario, insufficient_history: true, n: 12 },
    });
    const h = headwinds(
      c,
      "UNVALIDATED",
      [
        { id: "TB-1", status: "amber", value: "within 20%" },
        { id: "TB-2", status: "red", value: "hit" },
        { id: "TB-3", status: "green", value: "fine" },
      ],
      id,
    );
    const kinds = h.map((x) => x.kind);
    expect(kinds).toEqual([
      "Costs",
      "Thin trading",
      "Sizing",
      "Warning sign to watch",
      "Warning sign triggered",
      "Data flag",
      "Little history",
      "Evidence",
    ]);
    expect(h[0]!.text).toContain("1.54%");
    expect(h.some((x) => x.text.includes("TB-3"))).toBe(false); // green is not a headwind
  });
});

describe("UXN-037: Based on", () => {
  it("opens with two or three one-line reasons (at most 20 words) and a plain evidence line", () => {
    const items = basedOn(card(), id);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.length).toBeLessThanOrEqual(3);
    for (const i of items) expect(i.text.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(items.some((i) => i.text.includes("market mood"))).toBe(true);
    expect(evidenceLine("UNVALIDATED")).toBe(
      "This strategy is not proven yet — treat this as a learning example.",
    );
    expect(evidenceLine(null)).toBe(evidenceLine("UNVALIDATED"));
  });

  it("a reason from an announcement carries the announcement id; others carry none", () => {
    const c = card({
      family: "F2",
      rules_fired: [
        { rule: "event_results_or_guidance_up", value: "a", threshold: "b", pass: true },
        { rule: "volume_ratio", value: "3/2", threshold: ">= 3/2", pass: true },
      ],
      evidence: {
        ...card().evidence,
        events: [
          {
            source: "asx",
            ann_id: "A1",
            day0: "2026-10-15",
            category: "results",
            polarity: "1",
            price_sensitive: true,
            ar_ppm: 1,
            timed: true,
          },
        ] as never,
      },
    });
    const items = basedOn(c, id);
    expect(items[0]).toMatchObject({ newsId: "A1" });
    expect(items[1]!.newsId).toBeNull();
  });

  it("orders by the size of the factor contribution when there is one", () => {
    const c = card({
      rules_fired: [
        { rule: "volume_ratio", value: "2", threshold: ">= 1", pass: true },
        { rule: "high_lookback", value: "true", threshold: "20-session high", pass: true },
      ],
    });
    const items = basedOn(
      c,
      id,
      new Map([
        ["high_lookback", 50_000],
        ["volume_ratio", 1_000],
      ]),
    );
    expect(items[0]!.text).toContain("new long-term high");
  });
});

describe("UXN-100 / UXN-102 / UXN-126", () => {
  it("the scenario table has only Bad case / Typical / Good case with the three stored figures", () => {
    const rows = scenarioRows(card())!;
    expect(rows.map((r) => r.label)).toEqual(["Bad case", "Typical", "Good case"]);
    expect(rows.map((r) => r.percentile)).toEqual([
      "10th percentile",
      "50th percentile",
      "90th percentile",
    ]);
    expect(rows.map((r) => r.value)).toEqual(["-6.2%", "+3.1%", "+11.4%"]);
    expect(
      scenarioRows(card({ scenario: { ...card().scenario, insufficient_history: true } })),
    ).toBeNull();
  });

  it("Why? is rules-only, labelled, and introduces no number", () => {
    expect(WHY_LABEL).toBe("Rules-only (AI unavailable today)");
    const lines = whyLines(card(), checklist(card(), id), [{ id: "TB-X", status: "red" }], id);
    expect(lines.join(" ")).not.toMatch(/\d/);
    expect(lines.join(" ")).toContain("Warning signs to watch: TB-X.");
    expect(lines.join(" ")).not.toMatch(/\bwill\b/i);
  });

  it("afterwards: inside the usual range, worse than 9 in 10, better than 9 in 10, and still open", () => {
    expect(afterwards(card(), { net: 10_000, day: "2026-10-30" }, true)?.text).toContain(
      "inside the usual range",
    );
    expect(afterwards(card(), { net: -70_000, day: null }, true)?.text).toContain(
      "worse than 9 in 10 past setups",
    );
    expect(afterwards(card(), { net: 120_000, day: null }, true)?.text).toContain(
      "better than 9 in 10 past setups",
    );
    expect(afterwards(card(), null, true)?.state).toBe("open");
    expect(afterwards(card(), null, false)).toBeNull();
  });

  it("net after costs is exact: bigint cross-multiplication, truncated toward zero", () => {
    expect(netPpm(1_031_000n, 1_000_000n)).toBe(31_000);
    expect(netPpm(938_000n, 1_000_000n)).toBe(-62_000);
    expect(netPpm(1n, 0n)).toBeNull();
  });
});
