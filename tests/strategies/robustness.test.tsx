// M14 WP8 (D-251): the Robustness section component. Labels, empty state, "Not measured yet" for a
// missing figure, the fragile chip, the MinBTL line, and axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { Robustness } from "@/app/(app)/strategies/[execution]/Robustness";
import type { RobustnessView } from "@/lib/ui/loaders/robustness";

afterEach(cleanup);

const sum = (n: number, mean: number | null) => ({
  n,
  mean_net: mean,
  median_net: mean,
  hit_rate: 0.55,
  mean_sessions_held: 4.5,
});
const EMPTY: RobustnessView = {
  visible: true,
  measured: false,
  exitAblation: null,
  slip: null,
  stability: null,
  rankQuality: [],
  minBtl: null,
  errorBudget: null,
  ruleVersion: null,
  label: "descriptive — not a finding",
};
const FULL: RobustnessView = {
  ...EMPTY,
  measured: true,
  exitAblation: { rule: sum(80, 0.012), timeStopOnly: sum(80, null) },
  slip: { base: sum(80, 0.012), oneTick: sum(80, 0.009), stressMeanNet: null },
  stability: {
    passesAbsoluteGate: true,
    fragile: true,
    neighbours: [
      {
        setting: "Setting 1",
        direction: "down",
        value: 4,
        n: 70,
        meanNet: 0.01,
        netLower90: 0.002,
        passes: true,
      },
      {
        setting: "Setting 2",
        direction: "up",
        value: 6,
        n: 60,
        meanNet: -0.001,
        netLower90: null,
        passes: false,
      },
    ],
  },
  rankQuality: [
    { ranking: "Ranking 1", nDays: 400, medianIc: 0.031, lower90: 0.01, upper90: 0.05 },
  ],
  minBtl: { trials: 45, targetSharpe: 1, minYears: 5, availableYears: 3.2, label: "too short" },
  errorBudget: { mode: "alpha_spending", testsSoFar: 3, nextLevel: 0.0059, lessonPool: "open" },
};

describe("Robustness", () => {
  it("renders nothing for a role that may not see it", () => {
    const { container } = render(<Robustness view={{ ...EMPTY, visible: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says Not measured yet when nothing is stored, and still carries the label", () => {
    render(<Robustness view={EMPTY} />);
    const s = screen.getByRole("region", { name: "Robustness" });
    expect(within(s).getByText("Not measured yet")).toBeInTheDocument();
    expect(s.querySelector("[data-robustness-label]")?.textContent).toContain(
      "descriptive — not a finding",
    );
  });

  it("shows the tables, the fragile chip, MinBTL and the error budget", async () => {
    const { container } = render(<Robustness view={FULL} />);
    const s = screen.getByRole("region", { name: "Robustness" });
    expect(within(s).getAllByRole("table").length).toBeGreaterThanOrEqual(4);
    expect(s.querySelector("[data-fragile]")).not.toBeNull();
    expect(within(s).getAllByText("+1.20%").length).toBeGreaterThan(0);
    expect(s.querySelector("[data-min-btl]")?.textContent).toContain("too short");
    expect(s.querySelector("[data-min-btl]")?.textContent).toContain("45");
    expect(s.querySelector("[data-error-budget]")?.textContent).toContain("0.59%");
    // a missing figure is "Not measured yet", never 0 or blank
    expect(within(s).getAllByText("Not measured yet").length).toBeGreaterThan(0);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
