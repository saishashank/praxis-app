// @vitest-environment node
// D-955 plain words of "My portfolio": the split line, every trade reason and every split change in
// market words; the ban list (no strategy codes, rule versions, decision numbers, ISO dates, internal
// reason keys or broken values) is checked over every sentence the engine can write.
import { describe, expect, it } from "vitest";
import { getCostProfile } from "@/lib/arena/costs";
import { STRATEGY_NAMES_DEFAULT } from "@/lib/config/keys";
import { STRATEGIES } from "@/lib/picks/allocation";
import { simulatePortfolio, type DatedBar, type PortfolioPick } from "@/lib/picks/portfolio";
import {
  buyWords,
  exitWords,
  SHORTLIST_NAME,
  splitLine,
  splitWords,
  strategyNames,
  trimWords,
  type ExitKind,
} from "@/lib/picks/portfolioWords";

const families = Object.fromEntries(
  Object.entries(STRATEGY_NAMES_DEFAULT).map(([k, v]) => [k, v.name]),
);
const NAMES = strategyNames(families);
const W = {
  names: NAMES,
  weakAverageSessions: 20,
  shortlistAverageSessions: 20,
  strategyCapPpm: 400_000,
};

/** Words the Owner must never see in a portfolio sentence. */
const BANNED: readonly RegExp[] = [
  /\bF[1-6]\b/,
  /\bSL(\.v\d+)?\b/,
  /\bCAND/i,
  /\bD-\d{3}\b/,
  /\d{4}-\d{2}-\d{2}/,
  /\bppm\b/i,
  /\b(null|undefined|NaN|Infinity)\b/,
  /\b(time_frame|strategy_exit|rebalance|rule_version|none_left)\b/,
  /_/,
  /\bn\/a\b/,
];
const clean = (s: string) => BANNED.filter((re) => re.test(s)).map(String);

describe("names", () => {
  it("families by the strategy-name table, the shortlist its own, an unknown one generic", () => {
    expect(NAMES.F1).toBe("Follow the trend");
    expect(NAMES.SL).toBe(SHORTLIST_NAME);
    expect(strategyNames({}).F3).toBe("A strategy");
  });
});

describe("splitLine", () => {
  it("whole percents, largest first as given, cash takes the rest", () => {
    expect(
      splitLine(
        [
          { strategy: "F1", targetPpm: 350_000 },
          { strategy: "F2", targetPpm: 250_000 },
        ],
        400_000,
        NAMES,
      ),
    ).toBe("Follow the trend 35%, Good company, good news 25%, cash 40%");
    expect(splitLine([], 1_000_000, NAMES)).toBe("cash 100%");
    expect(
      splitLine(
        [
          { strategy: "F1", targetPpm: 600_000 },
          { strategy: "F2", targetPpm: 400_000 },
        ],
        0,
        NAMES,
      ),
    ).toBe("Follow the trend 60%, Good company, good news 40%");
    // a share under half a percent is not shown; its money is counted as cash
    expect(splitLine([{ strategy: "F1", targetPpm: 4_000 }], 996_000, NAMES)).toBe("cash 100%");
  });
});

describe("sentences", () => {
  it("every exit reason in plain words", () => {
    const kinds: ExitKind[] = [
      "stop",
      "gap",
      "aim",
      "time_frame",
      "weak",
      "strategy_exit",
      "rebalance",
      "none_left",
    ];
    for (const k of kinds)
      for (const s of STRATEGIES) {
        const text = exitWords(k, s, W);
        expect(clean(text), text).toEqual([]);
        expect(text.endsWith(".")).toBe(true);
      }
    expect(exitWords("strategy_exit", "SL", W)).toContain("20-day average");
  });

  it("buy and trim words", () => {
    expect(buyWords("F4", 250_000, 300_000, W)).toBe(
      `Bought as a ${NAMES.F4} pick: 25% of the money (${NAMES.F4}'s share is 30%).`,
    );
    expect(trimWords("SL", 520_000, 400_000, 100_000, W)).toBe(
      "Trimmed: Nightly shortlist had 52% of the money, more than 10% over its 40% share.",
    );
  });

  it("split changes: first, a newcomer, a leaver, more and less with the record", () => {
    const row = (
      strategy: "F1" | "F2" | "SL",
      targetPpm: number,
      o: Partial<{ n: number; mean: number; capped: boolean; weak: boolean }> = {},
    ) => ({
      strategy,
      targetPpm,
      n: 0,
      mean: 0,
      shrunkMean: 0,
      capped: false,
      weak: false,
      ...o,
    });
    expect(splitWords([row("F1", 400_000)], 600_000, null, W)).toContain("First split");
    expect(
      splitWords(
        [row("F1", 300_000), row("SL", 300_000)],
        400_000,
        [{ strategy: "F1", targetPpm: 400_000 }],
        W,
      ),
    ).toContain("Nightly shortlist comes in with a new pick.");
    expect(
      splitWords(
        [row("F1", 400_000)],
        600_000,
        [
          { strategy: "F1", targetPpm: 300_000 },
          { strategy: "F2", targetPpm: 300_000 },
        ],
        W,
      ),
    ).toContain("Good company, good news has no holding or pick now; its money waits as cash.");
    const more = splitWords(
      [row("F1", 400_000, { n: 12, mean: 0.031, capped: true }), row("F2", 200_000)],
      400_000,
      [
        { strategy: "F1", targetPpm: 300_000 },
        { strategy: "F2", targetPpm: 300_000 },
      ],
      W,
    );
    expect(more).toContain(
      "More for Follow the trend: 12 finished picks averaging +3.1% after costs; capped at 40%.",
    );
    const less = splitWords(
      [row("F1", 100_000, { n: 1, mean: -0.05, weak: true })],
      900_000,
      [{ strategy: "F1", targetPpm: 400_000 }],
      W,
    );
    expect(less).toContain(
      "Less for Follow the trend: 1 finished pick averaging -5.0% after costs; part kept as cash while its record is a loss.",
    );
    expect(
      splitWords([row("F1", 400_000)], 600_000, [{ strategy: "F1", targetPpm: 400_000 }], W),
    ).toBe("Follow the trend 40%, cash 60%.");
    for (const s of [more, less]) expect(clean(s), s).toEqual([]);
  });

  it("the ban list holds over a whole simulated run", () => {
    const M = 1_000_000n;
    const days = [
      "2030-03-01",
      "2030-03-04",
      "2030-03-05",
      "2030-03-06",
      "2030-03-07",
      "2030-03-08",
    ];
    const bar = (d: string, c: number, l = c, h = c): DatedBar => {
      const m = (x: number) => BigInt(Math.round(x * 1e6));
      return { d, openMicro: m(c), highMicro: m(h), lowMicro: m(l), closeMicro: m(c) };
    };
    const pick = (
      code: string,
      strategy: PortfolioPick["strategy"],
      rank: number,
    ): PortfolioPick => ({
      pubD: days[0]!,
      rank,
      code,
      strategy,
      tier: "U1",
      referenceMicro: 10n * M,
      entryD: days[1]!,
      entryMicro: 10n * M,
      stopMicro: 9n * M,
      aimMicro: 13n * M,
      timeFrameSessions: 2,
    });
    const r = simulatePortfolio(
      {
        picks: [pick("ZZA", "F1", 1), pick("ZZB", "SL", 2), pick("ZZC", "F2", 3)],
        finished: [{ strategy: "F2", exitD: days[2]!, netPpm: -40_000 }],
        bars: new Map([
          ["ZZA", days.map((d, i) => bar(d, [10, 10, 30, 30, 30, 30][i]!))],
          ["ZZB", days.map((d, i) => bar(d, [10, 10, 9.5, 9.5, 9.5, 9.5][i]!))],
          [
            "ZZC",
            days.map((d, i) => bar(d, [10, 10, 10, 10, 8.5, 8.5][i]!, i === 4 ? 8.5 : undefined)),
          ],
        ]),
        signalDays: new Map(),
        closeSignals: new Map([["F1|ZZA", new Set([days[4]!])]]),
        advMicro: new Map(),
        asOfD: days[5]!,
      },
      {
        seedMicro: 1_000n * M,
        minParcelMicro: 50n * M,
        strategyCapPpm: 400_000,
        costMaxPpm: 50_000,
        weakAverageSessions: 3,
        weakQuietSessions: 2,
        shortlistAverageSessions: 3,
        costProfile: getCostProfile("P6"),
        profile: {
          holdings: 4,
          riskPpm: 50_000,
          stockCapPpm: 300_000,
          smallStockCapPpm: 200_000,
          allocation: { shrinkN: 5, volTilt: 1, weakCash: 0.5 },
          bandPpm: 50_000,
          minHoldSessions: 0,
        },
        names: NAMES,
      },
    );
    const words = [...r.trades.map((t) => t.words), ...r.splits.map((s) => s.words)];
    expect(new Set(r.trades.map((t) => t.reason)).size).toBeGreaterThanOrEqual(3);
    expect(words.length).toBeGreaterThan(4);
    for (const w of words) expect(clean(w), w).toEqual([]);
  });
});
