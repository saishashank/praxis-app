// M21 C7 (UXN-154, D-1201; AT-82): the concentration chart. A donut up to 12 items, a treemap above;
// labels as given (the page passes masked ones); an aria-label, a legend and a screen-reader table.
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { ConcentrationChart, DONUT_MAX } from "@/components/charts/ConcentrationChart";

afterEach(cleanup);

const items = (k: number, each = 50_000) =>
  Array.from({ length: k }, (_, i) => ({
    label: `Stock ${i < 26 ? String.fromCharCode(65 + i) : `A${i}`}`,
    weightPpm: each - i,
    strategies: 1 + (i % 3),
  }));

describe("ConcentrationChart", () => {
  it("draws a donut for 12 items with an aria-label, a numbered legend and a table", () => {
    const { container } = render(<ConcentrationChart items={items(DONUT_MAX)} />);
    expect(container.querySelector("figure")?.getAttribute("data-chart")).toBe("donut");
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toMatch(/^Donut chart .*Stock A 5.00%/);
    expect(container.querySelectorAll("svg [data-slice]")).toHaveLength(13); // 12 + the rest
    const table = screen.getByRole("table", { name: "Share of all value by stock" });
    expect(within(table).getAllByRole("row")).toHaveLength(14);
    expect(within(table).getByRole("rowheader", { name: "Everything else" })).toBeInTheDocument();
  });
  it("draws a treemap for 13 items", () => {
    const { container } = render(<ConcentrationChart items={items(DONUT_MAX + 1)} />);
    expect(container.querySelector("figure")?.getAttribute("data-chart")).toBe("treemap");
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Treemap chart/);
    expect(container.querySelectorAll("svg rect")).toHaveLength(14);
  });
  it("keeps every treemap rectangle inside the frame and in proportion", () => {
    const { container } = render(<ConcentrationChart items={items(20, 40_000)} />);
    let area = 0;
    for (const r of container.querySelectorAll("svg rect")) {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((a) => Number(r.getAttribute(a)));
      expect(x! + w!).toBeLessThanOrEqual(320.01);
      expect(y! + h!).toBeLessThanOrEqual(180.01);
      area += w! * h!;
    }
    expect(Math.abs(area - 320 * 180)).toBeLessThan(60);
  });
  it("uses the labels it is given, so masked letters are all a masked viewer sees", () => {
    const { container } = render(
      <ConcentrationChart
        items={[
          { label: "Stock A", weightPpm: 600_000, strategies: 2 },
          { label: "Stock B", weightPpm: 400_000, strategies: 1 },
        ]}
      />,
    );
    expect(container.textContent).toContain("Stock A");
    expect(container.textContent).not.toContain("Everything else"); // 100% held
  });
  it("copes with one full item and with nothing", () => {
    const { container } = render(
      <ConcentrationChart items={[{ label: "Stock A", weightPpm: 1_000_000, strategies: 1 }]} />,
    );
    expect(container.querySelector("svg circle")).not.toBeNull();
    cleanup();
    const e = render(<ConcentrationChart items={[]} />);
    expect(e.container).toBeEmptyDOMElement();
  });
  it("passes axe", async () => {
    for (const k of [5, 15]) {
      const { container } = render(
        <main>
          <h1>t</h1>
          <ConcentrationChart items={items(k)} />
        </main>,
      );
      const r = await axe.run(container, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        rules: { "color-contrast": { enabled: false } },
      });
      expect(r.violations).toEqual([]);
      cleanup();
    }
  });
});
