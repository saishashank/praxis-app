// @vitest-environment node
// M23 R1 (D-1610): the report writer. Every section in the fixed order, only the three verdict words, a sensitivity
// variant labelled on every figure, no private path, no code.
import { describe, expect, it } from "vitest";
import {
  assertNoPrivateText,
  fmtNumber,
  levelText,
  renderReport,
  REPORT_SECTIONS,
  type ReportInput,
} from "@/lib/research/report";

const SHA = "a".repeat(64);

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    item: "CXA-901",
    title: "Synthetic breakout test",
    lineage: "zz_lineage",
    market: "ZZ",
    verdict: "PASS",
    hypothesis:
      "Names closing at a new high on heavy volume earn more than matched names over 60 sessions.",
    prereg: {
      file: "docs/research/prereg/CXA-901.json",
      sha256: SHA,
      commit: "1111111",
      date: "2026-11-17",
      runnerCommit: "2222222",
    },
    data: {
      sourceClass: "history extract",
      window: "2003 to 2026",
      universe: "largest tier as of each session",
      knownTime: "files count from their publication lag",
      caveats: ["survivors only", "static industry"],
    },
    split: {
      kind: "split",
      development: { from: "2003", to: "2021" },
      holdout: { from: "2021", to: "2026" },
    },
    n: { setups: 84, sessions: 70, blocks: 24, floorSetups: 60, floorBlocks: 20, floorMet: true },
    statistic: {
      definition: "Mean excess after the haircut, parts per million.",
      costProfile: "P6, each side",
      parcel: "600",
      control: "up to 20 matched, same tier and volatility decile",
      haircut: "1 point per 60 sessions held; figures with and without",
    },
    result: {
      unit: "parts per million of the entry value",
      alpha: 0.02,
      rows: [
        { window: "development", mean: 11234.5, lower: null, n: 200 },
        { window: "holdout", mean: 15000, lower: 4200, n: 84 },
        { window: "full", mean: 12000, lower: 5000, n: 284 },
      ],
    },
    verdictReason: "the lower bound is above zero",
    looks: [{ lineage: "zz_lineage", market: "ZZ", date: "2026-11-18", sha: SHA, verdict: "PASS" }],
    refusals: [],
    next: "Owner review for the shadow path.",
    ...over,
  };
}

describe("renderReport", () => {
  it("has every section, in order, and the status line", () => {
    const text = renderReport(input());
    let at = -1;
    for (const s of REPORT_SECTIONS) {
      const i = text.indexOf(`\n## ${s}\n`);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(text.startsWith("# CXA-901 Synthetic breakout test\n")).toBe(true);
    expect(text).toContain(
      "Item: CXA-901 (ch. 22) · Lineage: zz_lineage · Market: ZZ · Status: PASS",
    );
    expect(text).toContain(`sha256 ${SHA}`);
    expect(text).toContain(
      "84 setups · 70 sessions · 24 blocks · floor 60 setups and 20 blocks, met",
    );
    expect(text).toContain("Development 2003 to 2021 · holdout 2021 to 2026");
  });

  it("the result table shows the adjusted level, dashes for no bound, and the looks show 12 characters of the sha", () => {
    const text = renderReport(input());
    expect(text).toContain("| Window | Mean | 98 % lower bound | n |");
    expect(text).toContain("| development | 11234.5 | - | 200 |");
    expect(text).toContain("| holdout | 15000 | 4200 | 84 |");
    expect(text).toContain(`| zz_lineage | ZZ | 2026-11-18 | ${"a".repeat(12)} | PASS |`);
    expect(text).not.toContain("a".repeat(13) + " |");
    expect(text).toContain("Refusals: none");
  });

  it("accepts the three verdict words only, in the status, the verdict section and the looks", () => {
    for (const v of ["PASS", "NULL", "INCONCLUSIVE"]) {
      expect(renderReport(input({ verdict: v }))).toContain(`Status: ${v}`);
    }
    for (const bad of ["pass", "fail", "FAIL", "Pass", "", "INCONCLUSIVE "]) {
      expect(() => renderReport(input({ verdict: bad })), bad).toThrow();
    }
    expect(() =>
      renderReport(
        input({ looks: [{ lineage: "x", market: "ZZ", date: "d", sha: SHA, verdict: "fail" }] }),
      ),
    ).toThrow();
  });

  it("INCONCLUSIVE names what is missing and what fires the look; a verdict that is not INCONCLUSIVE does not", () => {
    const inc = renderReport(
      input({
        verdict: "INCONCLUSIVE",
        verdictReason: "the history this test needs does not exist yet",
        missingData: "announcement history",
        firesLater: "the forward collector reaches the floor",
        looks: [],
      }),
    );
    expect(inc).toContain("INCONCLUSIVE: the history this test needs does not exist yet");
    expect(inc).toContain("Missing: announcement history");
    expect(inc).toContain("The look fires later: the forward collector reaches the floor");
    expect(inc).toContain("No look has been taken.");
    expect(renderReport(input())).not.toContain("Missing:");
  });

  it("a full-window look states its reason", () => {
    const text = renderReport(
      input({ split: { kind: "full", reason: "too few holdout months for the effect size" } }),
    );
    expect(text).toContain("Full window, one look: too few holdout months for the effect size");
  });

  it("a sensitivity variant carries its label in the title, the statistic and nowhere else is it dropped", () => {
    const text = renderReport(
      input({ statistic: { ...input().statistic, variantLabel: "Larger account, not your book" } }),
    );
    expect(text.split("\n")[0]).toBe(
      "# CXA-901 Synthetic breakout test (Larger account, not your book)",
    );
    expect(text).toContain("Label on every figure here: Larger account, not your book");
    expect(renderReport(input())).not.toContain("Larger account");
  });

  it("refuses a bad sha and a private path, and carries no code", () => {
    expect(() => renderReport(input({ prereg: { ...input().prereg, sha256: "abc" } }))).toThrow();
    expect(() =>
      renderReport(
        input({
          data: { ...input().data, window: "read from D:\\Projects\\Praxis\\data\\history" },
        }),
      ),
    ).toThrow();
    expect(() => renderReport(input({ next: "see /Users/someone/history/file" }))).toThrow();
    expect(() => assertNoPrivateText("numbers only: 84 setups, 24 blocks")).not.toThrow();
    expect(renderReport(input())).not.toMatch(/\bZZ[A-Z0-9]{2,}\b/);
  });

  it("number and level formatting", () => {
    expect(fmtNumber(null)).toBe("-");
    expect(fmtNumber(46667)).toBe("46667");
    expect(fmtNumber(11333.6666)).toBe("11333.67");
    expect(levelText(0.1)).toBe("90 %");
    expect(levelText(0.02)).toBe("98 %");
    expect(levelText(0.1 / 3)).toBe("96.67 %");
  });
});
