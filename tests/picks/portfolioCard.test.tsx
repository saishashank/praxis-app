// D-913 "Follow the picks" card: before the first pick, with holdings and a closed tally, all in cash,
// and for a masked viewer (letters and percentages, no amounts).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortfolioCard } from "@/app/(app)/picks/PortfolioCard";
import type { PortfolioView } from "@/lib/ui/loaders/pickPortfolio";

afterEach(cleanup);

const m = (micro: string) => ({ micro, currency: "AUD" as const, simulated: true });
const base: PortfolioView = {
  masked: false,
  profile: "balanced",
  started: true,
  slots: 5,
  asOfD: "2030-03-05",
  seed: m("5000000000"),
  value: m("5100000000"),
  cash: m("4000000000"),
  sinceStartPpm: 20_000,
  holdings: [
    {
      stock: "ZZA",
      entryD: "2030-03-04",
      entry: m("10000000"),
      now: m("10500000"),
      changePpm: 50_000,
    },
  ],
  closed: 4,
  wins: 3,
  series: [0, 20_000],
};

describe("PortfolioCard (D-913)", () => {
  it("before the first pick it says when it starts", () => {
    render(<PortfolioCard v={{ ...base, started: false, asOfD: null, holdings: [] }} />);
    expect(screen.getByText("Starts with the first pick.")).toBeInTheDocument();
    expect(screen.getByText(/at most 5 stocks at once/)).toBeInTheDocument();
  });

  it("shows the value, the start, cash, the closed tally and each holding", () => {
    render(<PortfolioCard v={base} />);
    const card = screen.getByTestId("pick-portfolio");
    expect(card).toHaveTextContent("+2.0% since the start");
    expect(card).toHaveTextContent("Started with");
    expect(card).toHaveTextContent("4 closed, 3 with a gain (75%).");
    expect(screen.getByRole("list", { name: "Holdings" })).toHaveTextContent("ZZA");
    expect(card).toHaveTextContent("(+5.0%)");
  });

  it("all in cash and nothing closed", () => {
    render(<PortfolioCard v={{ ...base, holdings: [], closed: 0, wins: 0 }} />);
    expect(screen.getByText("No trade closed yet.")).toBeInTheDocument();
    expect(screen.getByText("All in cash: waiting for the next good pick.")).toBeInTheDocument();
  });

  it("a masked viewer sees the letter and percentages, no amounts", () => {
    const { container } = render(
      <PortfolioCard
        v={{
          ...base,
          masked: true,
          asOfD: null,
          seed: null,
          value: null,
          cash: null,
          holdings: [{ stock: "Stock A", entryD: null, entry: null, now: null, changePpm: 50_000 }],
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Stock A");
    expect(text).toContain("+5.0%");
    expect(text).not.toMatch(/A\$|\$\d/);
    expect(text).not.toContain("Started with");
  });
});
