// @vitest-environment node
// AT-55 (M15; CTX-070, CTX-073): cards are built from the phrase table with the ban list, and the
// glossary has an entry for every Cortex term.
//  1. Static: no renderer in src/lib/cortex/phrases.ts contains a word of its own; every phrase, word
//     table entry and gate label is free of the banned terms.
//  2. Banned-word grep over five rendered sample cards on synthetic ZZ data. The five cards are the
//     fixtures below; their exact text is what the Owner reads back at merge time (D-274).
//  3. Glossary completeness against the CTX-073 term list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cortexBlockOf } from "@/lib/agents/cards";
import { G08_LABELS, GATE_LABELS, OPEN_LABELS } from "@/lib/cortex/gates/list";
import type { CardFields } from "@/lib/cortex/night";
import {
  CARD_BANNED,
  CLUSTER_WORD,
  FAMILY_WORD,
  PHRASES,
  REGIME_WORD,
  SOURCE_WORD,
  cortexCardLines,
  type CardLineInput,
} from "@/lib/cortex/phrases";
import { ANGLE_CLUSTERS } from "@/lib/cortex/angles/types";
import { INPUT_KINDS } from "@/lib/cortex/pit/types";

const ROOT = process.cwd();
const PHRASES_SRC = readFileSync(join(ROOT, "src/lib/cortex/phrases.ts"), "utf8");

const banned = (s: string): string[] => CARD_BANNED.filter((re) => re.test(s)).map(String);

// ---- 1. static: the phrase table ---------------------------------------------------------------------

describe("AT-55 phrase table (static)", () => {
  it("no phrase, word-table entry or gate label contains a banned term", () => {
    const all = [
      ...Object.values(PHRASES),
      ...Object.values(FAMILY_WORD),
      ...Object.values(CLUSTER_WORD),
      ...Object.values(SOURCE_WORD),
      ...Object.values(REGIME_WORD),
      ...Object.values(GATE_LABELS),
      ...Object.values(G08_LABELS),
      ...Object.values(OPEN_LABELS),
    ];
    for (const s of all) expect(banned(s), s).toEqual([]);
  });

  it("every cluster, input kind and regime has a plain word", () => {
    for (const c of ANGLE_CLUSTERS) expect(CLUSTER_WORD[c], c).toBeTruthy();
    for (const k of INPUT_KINDS) expect(SOURCE_WORD[k], k).toBeTruthy();
    for (const r of ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL", "unknown"]) {
      expect(REGIME_WORD[r], r).toBeTruthy();
    }
  });

  it("the renderers contain no words of their own: every letter run sits in the table or a ${} slot", () => {
    const at = PHRASES_SRC.indexOf("// ---- renderers");
    expect(at).toBeGreaterThan(0);
    const code = PHRASES_SRC.slice(at)
      .replace(/\/\/.*$/gm, "") // line comments
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Quoted literals ("..." and `...`) with the ${...} slots cut out.
    const literals = [...code.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) =>
      (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, ""),
    );
    for (const lit of literals) expect(lit, lit).not.toMatch(/[A-Za-z]{2,}/);
  });
});

// ---- 2. five rendered sample cards ------------------------------------------------------------------------

const base: CardFields = {
  similar: { p: 0.6, lo: 0.52, hi: 0.68, n: 84 },
  breakEven: [
    { c: 0.025, pBe: 0.531 },
    { c: 0.05, pBe: 0.563 },
    { c: 0.075, pBe: 0.595 },
  ],
  reasonsFor: ["momentum", "liquidity", "event"],
  reasonsAgainst: ["sentiment"],
  wouldHaveStopped: null,
  regime: "RISK-ON",
  independentSources: ["bar_au", "index_au", "announcement"],
  costPerOrderPpm: 12_000,
};

type Sample = { name: string; input: CardLineInput; expected: readonly string[] };
const sample = (
  name: string,
  over: Partial<CardFields>,
  head: { code: string; family: string; taken: boolean; regime: string },
  abstain: string | null,
  expected: readonly string[],
): Sample => ({
  name,
  input: {
    ...head,
    cortex: cortexBlockOf({ ...base, ...over, regime: head.regime as never }, abstain),
  },
  expected,
});

/** The five sample cards recorded for the Owner read-back (D-274). Synthetic ZZ codes only. */
const SAMPLE_CARDS: readonly Sample[] = [
  sample(
    "1 taken, trend breakout, with a range",
    {},
    { code: "ZZA", family: "F1", taken: true, regime: "RISK-ON" },
    null,
    [
      "Praxis would buy ZZA tonight as a trend breakout setup.",
      "About 6 in 10 similar past setups came out ahead after costs (range 5 to 7 in 10), based on 84 past setups.",
      "Break-even: if costs take 2.5%, 5% and 7.5% of the trade, about 5.3, 5.6 and 5.9 in 10 trades must come out ahead to pay for them.",
      "Reasons for: recent price strength, easy to buy and sell and recent company news.",
      "Reasons against: the mood of the news.",
      "Nothing would have stopped us.",
      "Market mood: confident.",
      "Based on 3 independent kinds of information: daily prices, the Australian market index and company announcements.",
      "Costs for this order: 1.2% of its value, in and out.",
    ],
  ),
  sample(
    "2 shadow, mean reversion, portfolio check would have stopped it",
    {
      similar: { p: 0.55, lo: null, hi: null, n: 140 },
      reasonsFor: ["low_volatility"],
      reasonsAgainst: ["momentum", "event"],
      wouldHaveStopped: "G11_portfolio",
      independentSources: ["bar_au"],
    },
    { code: "ZZB", family: "F4", taken: false, regime: "NEUTRAL" },
    null,
    [
      "Praxis looked at ZZB tonight as a mean reversion setup but would not buy it.",
      "About 6 in 10 similar past setups came out ahead after costs, based on 140 past setups.",
      "Break-even: if costs take 2.5%, 5% and 7.5% of the trade, about 5.3, 5.6 and 5.9 in 10 trades must come out ahead to pay for them.",
      "Reasons for: calm trading.",
      "Reasons against: recent price strength and recent company news.",
      "What would have stopped us: we already hold enough of this company.",
      "Market mood: neutral.",
      "Based on 1 independent kind of information: daily prices.",
      "Costs for this order: 1.2% of its value, in and out.",
    ],
  ),
  sample(
    "3 taken, catalyst drift, probability hidden",
    { similar: null, reasonsFor: ["event", "quality"], reasonsAgainst: [] },
    { code: "ZZC", family: "F2", taken: true, regime: "RISK-OFF" },
    null,
    [
      "Praxis would buy ZZC tonight as a catalyst drift setup.",
      "No estimate is shown for this setup.",
      "Break-even: if costs take 2.5%, 5% and 7.5% of the trade, about 5.3, 5.6 and 5.9 in 10 trades must come out ahead to pay for them.",
      "Reasons for: recent company news and company quality.",
      "Reasons against: nothing stands out.",
      "Nothing would have stopped us.",
      "Market mood: cautious.",
      "Based on 3 independent kinds of information: daily prices, the Australian market index and company announcements.",
      "Costs for this order: 1.2% of its value, in and out.",
    ],
  ),
  sample(
    "4 not taken, small-company discovery, settled cash",
    {
      similar: { p: 0.62, lo: null, hi: null, n: 61 },
      wouldHaveStopped: "G12_settled_cash",
      costPerOrderPpm: 31_500,
      independentSources: ["bar_au", "announcement", "sector_map", "calendar"],
    },
    { code: "ZZD", family: "F5", taken: false, regime: "SHOCK" },
    null,
    [
      "Praxis looked at ZZD tonight as a small-company discovery setup but would not buy it.",
      "About 6 in 10 similar past setups came out ahead after costs, based on 61 past setups.",
      "Break-even: if costs take 2.5%, 5% and 7.5% of the trade, about 5.3, 5.6 and 5.9 in 10 trades must come out ahead to pay for them.",
      "Reasons for: recent price strength, easy to buy and sell and recent company news.",
      "Reasons against: the mood of the news.",
      "What would have stopped us: the cash from the last sale has not settled yet.",
      "Market mood: a sudden shock.",
      "Based on 4 independent kinds of information: daily prices, company announcements, industry groups and the trading calendar.",
      "Costs for this order: 3.2% of its value, in and out.",
    ],
  ),
  sample(
    "5 abstain",
    {},
    { code: "ZZE", family: "F3", taken: false, regime: "unknown" },
    GATE_LABELS.G03_family_status,
    ["No trade tonight for this book: this strategy is not yet allowed to trade."],
  ),
];

describe("AT-55 five sample cards", () => {
  it("renders exactly the recorded text for each card", () => {
    for (const s of SAMPLE_CARDS) expect(cortexCardLines(s.input), s.name).toEqual(s.expected);
  });

  it("a grep for banned words over every rendered card finds nothing", () => {
    for (const s of SAMPLE_CARDS) {
      const text = cortexCardLines(s.input).join("\n");
      expect(banned(text), s.name).toEqual([]);
      // No gate id, no raw cluster key and no field name leaks through.
      expect(text, s.name).not.toMatch(/G\d\d|_/);
    }
  });

  it("an interval is shown only when the card carries one (D-339); a hidden estimate says so", () => {
    expect(cortexCardLines(SAMPLE_CARDS[0]!.input)[1]).toContain("(range ");
    expect(cortexCardLines(SAMPLE_CARDS[1]!.input)[1]).not.toContain("range");
    expect(cortexCardLines(SAMPLE_CARDS[2]!.input)[1]).toBe(PHRASES.similarNone);
  });

  it("the check that would have stopped a trade is named by its plain label, never its id", () => {
    const lines = cortexCardLines(SAMPLE_CARDS[1]!.input).join("\n");
    expect(lines).toContain(GATE_LABELS.G11_portfolio);
    expect(lines).not.toContain("G11");
  });
});

// ---- 3. glossary completeness -------------------------------------------------------------------------------

/** CTX-073: the terms the glossary must define. */
const CTX_073_TERMS = [
  "Cortex",
  "book",
  "family",
  "cluster",
  "angle",
  "matched setups",
  "comparable cases",
  "break-even",
  "allowed to trade",
  "live-tested",
  "shadow",
  "warming up",
  "parcel",
  "settled cash",
  "stall",
  "halt",
  "suspension",
  "regime",
  "ATR",
  "gap",
] as const;

describe("AT-55 glossary", () => {
  const md = readFileSync(join(ROOT, "docs/glossary.md"), "utf8");
  const section = md.slice(md.indexOf("## Cortex terms"));
  const headings = [...section.matchAll(/^### (.+)$/gm)].map((m) =>
    (m[1] ?? "")
      .replace(/\s*\(.*\)\s*$/, "")
      .trim()
      .toLowerCase(),
  );

  it("has the Cortex terms section", () => {
    expect(md.indexOf("## Cortex terms")).toBeGreaterThan(0);
  });

  it("has one entry for every CTX-073 term, and no entry the list lacks", () => {
    expect([...headings].sort()).toEqual(CTX_073_TERMS.map((t) => t.toLowerCase()).sort());
  });

  it("every entry has a meaning and a spec line", () => {
    const blocks = section.split(/^### /m).slice(1);
    expect(blocks).toHaveLength(CTX_073_TERMS.length);
    for (const b of blocks) {
      const lines = b.trim().split("\n");
      expect(lines.length, lines[0]).toBeGreaterThanOrEqual(2);
      expect(lines.at(-1), lines[0]).toMatch(/^_Spec: .*CTX-073/);
    }
  });
});
