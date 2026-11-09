// D-884/D-885: the trades table of a strategy round (Open first, Closed, All).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TradesTable, type ChartTrade } from "@/app/(app)/strategies/[execution]/StrategyChart";

vi.mock("lightweight-charts", () => ({}));
afterEach(cleanup);

const trade = (over: Partial<ChartTrade>): ChartTrade => ({
  key: "t1",
  stock: "AAA",
  entryDate: "2026-11-03",
  exitDate: null,
  entryDay: "2026-11-03",
  exitDay: null,
  qty: 4,
  open: true,
  returnText: null,
  pnlText: null,
  entryPriceText: "A$10.00",
  exitPriceText: null,
  stopText: "A$9.00",
  targetText: "A$12.00",
  lastPriceText: "A$10.50",
  lastPriceAtText: null,
  openReturnText: null,
  cardHref: "/cards/x",
  ...over,
});

describe("TradesTable (D-884, D-885)", () => {
  it("Open by default with size, buy price, stop, target and price now; Closed shows the sell", () => {
    const onPick = vi.fn();
    render(
      <TradesTable
        trades={[
          trade({}),
          trade({
            key: "t2",
            stock: "BBB",
            open: false,
            exitDay: "2026-11-04",
            exitPriceText: "A$11.00",
            pnlText: "+A$4.00",
            cardHref: null,
          }),
        ]}
        selected={null}
        onPick={onPick}
      />,
    );
    let table = screen.getByRole("table", { name: /open/ });
    expect(table).toHaveTextContent("AAA");
    expect(table).not.toHaveTextContent("BBB");
    for (const t of ["A$10.00", "A$9.00", "A$12.00", "A$10.50", "Open"])
      expect(table).toHaveTextContent(t);
    fireEvent.click(within(table).getByText("AAA"));
    expect(onPick).toHaveBeenCalledWith("t1");

    fireEvent.click(screen.getByRole("button", { name: "Closed (1)" }));
    table = screen.getByRole("table", { name: /closed/ });
    expect(table).toHaveTextContent("BBB");
    expect(table).toHaveTextContent("sold 2026-11-04");
    expect(table).toHaveTextContent("A$11.00");
    expect(table).toHaveTextContent("+A$4.00");
    expect(table).toHaveTextContent("No card");
    expect(within(table).getByRole("columnheader", { name: "Sell price" })).toBeInTheDocument();
  });

  it("says so when a view is empty; hidden prices read Hidden", () => {
    render(
      <TradesTable
        trades={[
          trade({
            open: false,
            entryPriceText: null,
            stopText: null,
            targetText: null,
            exitPriceText: null,
            exitDay: "2026-W45",
          }),
        ]}
        selected="t1"
        onPick={() => undefined}
      />,
    );
    expect(screen.getByText("No open trades right now.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All (1)" }));
    const table = screen.getByRole("table", { name: /all/ });
    expect(within(table).getAllByText("Hidden").length).toBeGreaterThanOrEqual(4);
    expect(table.querySelector("[aria-selected='true']")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Closed (1)" }));
    expect(screen.getByRole("table", { name: /closed/ })).toBeInTheDocument();
  });

  it("a round with no closed trade says so on Closed", () => {
    render(<TradesTable trades={[trade({})]} selected={null} onPick={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Closed (0)" }));
    expect(screen.getByText("No closed trades in this round yet.")).toBeInTheDocument();
  });
});

describe("TradesTable live price (D-900)", () => {
  it("an open trade with a delayed quote shows its time and the move since the buy", () => {
    render(
      <TradesTable
        trades={[trade({ lastPriceAtText: "delayed, 11:35", openReturnText: "▲ +5.0 %" })]}
        selected={null}
        onPick={vi.fn()}
      />,
    );
    const table = screen.getByRole("table", { name: /open/ });
    expect(table).toHaveTextContent("delayed, 11:35");
    expect(table).toHaveTextContent("Open ▲ +5.0 %");
  });
});
