// M21 C7 (UXN-062, D-1201; AT-82): the factual card above "Matched controls".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlsSummary } from "@/app/(app)/strategies/leaderboard/ControlsSummary";
import type { LeaderRow } from "@/lib/ui/loaders/strategies";

afterEach(cleanup);

const row = (name: string, finished: number, meanReturnPpm: number | null): LeaderRow => ({
  execution: name,
  kind: "E",
  family: null,
  variant: null,
  name,
  label: null,
  rounds: finished,
  finished,
  live: 0,
  reachedTarget: 0,
  busted: 0,
  stalled: 0,
  timedOut: 0,
  meanReturnPpm,
  recostNav: null,
});

const text = () => (screen.getByTestId("controls-summary").textContent ?? "").replace(/−/g, "-");

describe("ControlsSummary", () => {
  it("names the best strategy, its mean per finished round and the controls range", () => {
    render(
      <ControlsSummary
        strategies={[row("Breakout", 4, 52_000), row("Bounce", 3, -10_000), row("Fresh", 0, null)]}
        controls={[row("Index fund", 5, 20_000), row("Random twin", 5, -15_000)]}
      />,
    );
    expect(text()).toBe(
      "Best strategy: Breakout, +5.20% per finished round; matched controls: -1.50% to +2.00%",
    );
  });
  it("shows one value when every control has the same mean and says so when none is measured", () => {
    render(<ControlsSummary strategies={[row("A", 3, 10_000)]} controls={[row("C", 3, 10_000)]} />);
    expect(text()).toMatch(/matched controls: \+1.00%$/);
    cleanup();
    render(<ControlsSummary strategies={[row("A", 3, 10_000)]} controls={[row("C", 0, null)]} />);
    expect(text()).toMatch(/matched controls: not measured yet$/);
  });
  it("renders nothing before any strategy has a finished round, and ties go to the earlier name", () => {
    const { container } = render(
      <ControlsSummary strategies={[row("A", 0, null)]} controls={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
    cleanup();
    render(
      <ControlsSummary strategies={[row("Zed", 3, 5_000), row("Alpha", 3, 5_000)]} controls={[]} />,
    );
    expect(text()).toContain("Best strategy: Alpha,");
  });
  it("contains no internal code", () => {
    render(<ControlsSummary strategies={[row("Breakout", 3, 5_000)]} controls={[]} />);
    expect(text()).not.toMatch(/\b(E|F|C)\d{1,2}\b/);
  });
});
