// M20 S1 (MKT-113, D-1099): the Usage page card "Projection per market": every built market with its data-market
// attribute, enabled or not; the figures it adds, the total with AU, the line and the verdict; a market with no
// projection says why; an unreadable projection says so without details.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectionSection } from "@/app/(app)/usage/ProjectionSection";
import { fits, limitsOf, type Figures, type ProjectionReport } from "@/lib/usage/projection";

afterEach(cleanup);

const fig = (o: Partial<Figures> = {}): Figures => ({
  turso_reads: 0,
  turso_writes: 0,
  actions_minutes: 0,
  worker_requests: 0,
  host_requests: 0,
  ...o,
});
const limits = limitsOf({ tursoCeilingPct: 20, actionsSoftCeiling: 3000 });
const au = fig({ turso_reads: 21_000_000, turso_writes: 420_000 });
const us = fig({ turso_reads: 27_511_000, turso_writes: 551_100 });
const report: ProjectionReport = {
  au,
  auCodes: 2000,
  limits,
  window: { from: "a", to: "b" },
  markets: [
    {
      market: "IN",
      enabled: false,
      cap: null,
      sessions: 20,
      projected: null,
      note: "No universe cap in the profile.",
    },
    { market: "US", enabled: true, cap: 2500, sessions: 22, projected: us, note: null },
  ],
  fitsWith: { IN: null, US: fits({ au, markets: [us], limits }) },
};

describe("ProjectionSection", () => {
  it("one block per built market with data-market, the verdict and the hand-computed totals", () => {
    const { container } = render(<ProjectionSection report={report} />);
    expect(screen.getByRole("heading", { name: "Projection per market" })).toBeInTheDocument();
    expect(container.querySelector("#projection")).not.toBeNull(); // the checklist links to /usage#projection
    const blocks = [...container.querySelectorAll("[data-market]")];
    expect(
      blocks.map((b) => [b.getAttribute("data-market"), b.getAttribute("data-enabled")]),
    ).toEqual([
      ["IN", "0"],
      ["US", "1"],
    ]);
    const usBlock = container.querySelector('[data-market="US"]') as HTMLElement;
    expect(within(usBlock).getByText("FITS")).toBeInTheDocument();
    // US adds 27,511,000 reads; the total with AU is 48,511,000 against a line of 100,000,000 (48.5 % of 500 M is 9.7 %)
    const reads = usBlock.querySelector('[data-metric="turso_reads"]') as HTMLElement;
    expect(reads).toHaveTextContent("27,511,000");
    expect(reads).toHaveTextContent("48,511,000");
    expect(reads).toHaveTextContent("100,000,000");
    expect(reads).toHaveTextContent("9.7%");
    expect(reads.getAttribute("data-ok")).toBe("1");
  });

  it("a market with no projection says why, and shows no verdict", () => {
    const { container } = render(<ProjectionSection report={report} />);
    const inBlock = container.querySelector('[data-market="IN"]') as HTMLElement;
    expect(inBlock).toHaveTextContent("No projection: No universe cap in the profile.");
    expect(within(inBlock).queryByText("FITS")).toBeNull();
    expect(within(inBlock).queryByText("DOES NOT FIT")).toBeNull();
  });

  it("a market over the line is marked DOES NOT FIT", () => {
    const big = fig({ turso_reads: 80_000_000 });
    const r = {
      ...report,
      markets: [{ ...report.markets[1]!, projected: big }],
      fitsWith: { US: fits({ au, markets: [big], limits }) },
    };
    render(<ProjectionSection report={r} />);
    expect(screen.getByText("DOES NOT FIT")).toBeInTheDocument();
  });

  it("an unreadable projection says so without details", () => {
    render(<ProjectionSection report={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Projection unavailable");
  });
});
