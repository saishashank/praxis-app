// D-950 "My portfolio" card: three portfolios side by side; before the first pick, with holdings, the
// split and the latest trades, all in cash, a loss with its worst fall, and a masked viewer (letters
// and percentages, no amounts or dates).
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortfolioCard } from "@/app/(app)/picks/PortfolioCard";
import type { MyPortfolio, MyPortfoliosView } from "@/lib/ui/loaders/pickPortfolio";

afterEach(cleanup);

const m = (micro: string) => ({ micro, currency: "AUD" as const, simulated: true as const });
const one = (profile: string, over: Partial<MyPortfolio> = {}): MyPortfolio => ({
  profile,
  started: true,
  holdingsMax: 4,
  asOfD: "2030-03-05",
  seed: m("1000000000"),
  value: m("1012300000"),
  cash: m("600000000"),
  gain: m("12300000"),
  sinceStartPpm: 12_300,
  worstFallPpm: -8_000,
  holdings: [
    {
      stock: "ZZA",
      strategy: "Follow the trend",
      entryD: "2030-03-04",
      entry: m("10000000"),
      now: m("10500000"),
      changePpm: 50_000,
    },
  ],
  split: "Follow the trend 40%, Nightly shortlist 25%, cash 35%",
  splitWhy: "Nightly shortlist comes in with a new pick.",
  trades: [
    {
      d: "2030-03-04",
      stock: "ZZA",
      words: "Bought as a Follow the trend pick: 25% of the money.",
    },
  ],
  closed: 4,
  wins: 3,
  ...over,
});
const base: MyPortfoliosView = {
  masked: false,
  seed: m("1000000000"),
  stockMaxPct: 30,
  strategyMaxPct: 40,
  portfolios: [one("conservative"), one("balanced"), one("aggressive", { holdingsMax: 3 })],
};

describe("PortfolioCard (D-950)", () => {
  it("shows the three profiles side by side with value, profit, worst fall, split and holdings", () => {
    render(<PortfolioCard v={base} />);
    const card = screen.getByTestId("pick-portfolio");
    expect(card).toHaveTextContent("My portfolio");
    expect(card).toHaveTextContent("each started with A$1,000.00");
    expect(card).toHaveTextContent("at most 40% each");
    expect(card).toHaveTextContent("at most 30% in one stock");
    for (const p of ["conservative", "balanced", "aggressive"]) {
      const box = screen.getByTestId(`my-portfolio-${p}`);
      expect(box).toHaveTextContent("+A$12.30 (+1.2%)");
      expect(box).toHaveTextContent("Worst fall from a peak: -0.8%.");
      expect(within(box).getByTestId("portfolio-split")).toHaveTextContent(
        "Split: Follow the trend 40%, Nightly shortlist 25%, cash 35%",
      );
      expect(box).toHaveTextContent("Nightly shortlist comes in with a new pick.");
      expect(box).toHaveTextContent(
        "ZZA (Follow the trend) bought at A$10.00 on Mon 4 Mar 2030, now A$10.50",
      );
      expect(box).toHaveTextContent("4 sold, 3 with a gain (75%).");
      expect(box).toHaveTextContent("Mon 4 Mar 2030: ZZA. Bought as a Follow the trend pick");
      expect(box.textContent ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(screen.getByRole("heading", { name: "Conservative" })).toBeInTheDocument();
  });

  it("before the first pick, all in cash, nothing sold, no fall yet", () => {
    render(
      <PortfolioCard
        v={{
          ...base,
          portfolios: [
            one("conservative", { started: false, asOfD: null, holdings: [] }),
            one("balanced", {
              holdings: [],
              closed: 0,
              wins: 0,
              worstFallPpm: 0,
              split: null,
              splitWhy: null,
              trades: [],
            }),
            one("aggressive", { gain: m("-5000000"), sinceStartPpm: -5_000 }),
          ],
        }}
      />,
    );
    expect(
      within(screen.getByTestId("my-portfolio-conservative")).getByText(
        "Starts with the first pick.",
      ),
    ).toBeInTheDocument();
    const bal = screen.getByTestId("my-portfolio-balanced");
    expect(bal).toHaveTextContent("All in cash: waiting for a good pick.");
    expect(bal).toHaveTextContent("No holding sold in full yet.");
    expect(bal).toHaveTextContent("Worst fall from a peak: none yet.");
    expect(screen.getByTestId("my-portfolio-aggressive")).toHaveTextContent("-A$5.00 (-0.5%)");
  });

  it("a masked viewer sees letters and percentages, no amounts or dates", () => {
    const masked = (p: string) =>
      one(p, {
        asOfD: null,
        seed: null,
        value: null,
        cash: null,
        gain: null,
        holdings: [
          {
            stock: "Stock A",
            strategy: "Follow the trend",
            entryD: null,
            entry: null,
            now: null,
            changePpm: 50_000,
          },
        ],
        trades: [{ d: null, stock: "Stock A", words: "Sold at the aim." }],
      });
    const { container } = render(
      <PortfolioCard
        v={{
          ...base,
          masked: true,
          seed: null,
          portfolios: ["conservative", "balanced", "aggressive"].map(masked),
        }}
      />,
    );
    // the one fixed amount is the ASX rule in the help list, not a portfolio figure
    const text = (container.textContent ?? "").replace("at least A$500", "");
    expect(text).toContain("Stock A");
    expect(text).toContain("+5.0%");
    expect(text).toContain("+1.2%");
    expect(text).not.toMatch(/A\$|\$\d/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}|Mar/);
  });
});
