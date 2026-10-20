// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BustBar,
  CalendarGrid,
  CifCurve,
  CifTable,
  Gauge,
  GlyphBar,
  HBar,
  HeatGrid,
  Sparkline,
  StatusRing,
} from "@/components/charts";
import {
  TimeSeriesChart,
  readChartTheme,
  type TimePoint,
} from "@/components/charts/TimeSeriesChart";

const applyOptions = vi.fn();
const seriesApply = vi.fn();
const remove = vi.fn();
vi.mock("lightweight-charts", () => ({
  ColorType: { Solid: "solid" },
  LineSeries: "line",
  AreaSeries: "area",
  createChart: vi.fn(() => ({
    addSeries: () => ({ setData: vi.fn(), applyOptions: seriesApply }),
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions,
    remove,
  })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const days: TimePoint[] = Array.from({ length: 120 }, (_, i) => ({
  time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  value: 100 + i * 0.5,
}));

const svgs: Record<string, React.ReactElement> = {
  sparkline: <Sparkline label="BHP close" values={[10, 11, null, 9, 12]} />,
  glyphBar: <GlyphBar nav={640} />,
  bustBarSafe: <BustBar nav={600} />,
  bustBarNear: <BustBar nav={340} />,
  bustBarBusted: <BustBar nav={250} />,
  gauge: <Gauge value={82} label="Budget used" />,
  statusRing: (
    <StatusRing
      segments={Array.from({ length: 9 }, (_, i) => ({
        id: `s${i}`,
        label: `Part ${i + 1}`,
        healthy: i !== 3,
      }))}
    />
  ),
  heatGrid: (
    <HeatGrid
      label="Sectors"
      cells={[
        { label: "Banks", value: 1.2 },
        { label: "Miners", value: -2.4 },
        { label: "Tech", value: null },
      ]}
    />
  ),
  calendarGrid: (
    <CalendarGrid
      label="Daily result"
      currency="A$"
      days={[
        { date: "2026-10-01", value: 3.5 },
        { date: "2026-10-02", value: -1 },
        { date: "2026-10-03", value: null },
      ]}
    />
  ),
  hbar: (
    <HBar
      label="Factors"
      items={[
        { label: "Momentum", value: 1.5 },
        { label: "A very long factor name here", value: -0.7 },
      ]}
    />
  ),
  cifCurve: (
    <CifCurve
      series={[
        {
          name: "Target",
          points: [
            { month: 0, p: 0 },
            { month: 6, p: 0.2, lo: 0.1, hi: 0.3 },
            { month: 12, p: 0.4, lo: 0.25, hi: 0.55 },
          ],
        },
        {
          name: "Bust",
          points: [
            { month: 0, p: 0 },
            { month: 12, p: 0.1, lo: 0.05, hi: 0.2 },
          ],
        },
      ]}
    />
  ),
};

describe("inline SVG charts", () => {
  for (const [name, el] of Object.entries(svgs)) {
    it(`${name}: deterministic snapshot`, () => {
      const a = renderToStaticMarkup(el);
      expect(a).toBe(renderToStaticMarkup(el));
      expect(a).toMatchSnapshot();
    });
  }

  it("every chart has role=img with a non-empty accessible name and a data table", () => {
    for (const el of Object.values(svgs)) {
      const { container, unmount } = render(el);
      const img = container.querySelector('[role="img"]');
      expect(img?.getAttribute("aria-label")?.length).toBeGreaterThan(10);
      expect(container.querySelector("table caption")).not.toBeNull();
      expect(container.querySelectorAll("table th").length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("uses theme tokens only: no colour literals, every var() exists in all six themes", () => {
    const css = readFileSync("src/styles/themes.css", "utf8");
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = noComments.split(/^\}/m).filter((b) => /^\s*:root\[data-theme=[^{]*\{/.test(b));
    expect(blocks.length).toBeGreaterThanOrEqual(5); // dark, light (+system), midnight, dim, high_contrast
    const html = Object.values(svgs)
      .map((e) => renderToStaticMarkup(e))
      .join("");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    const used = new Set([...html.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(4);
    for (const token of used) {
      for (const block of blocks) expect(block).toContain(`${token}:`);
    }
  });

  it("does not rely on colour alone: signs, arrows, and states appear as text", () => {
    expect(renderToStaticMarkup(svgs.heatGrid!)).toMatch(/▲ \+1\.2%[\s\S]*▼ −2\.4%/);
    expect(renderToStaticMarkup(svgs.bustBarNear!)).toContain("Near bust");
    expect(renderToStaticMarkup(svgs.bustBarBusted!)).toContain("Busted");
    expect(renderToStaticMarkup(svgs.statusRing!)).toContain("8 / 9");
  });

  it("handles empty, zero and missing values", () => {
    expect(renderToStaticMarkup(<Sparkline label="X" values={[]} />)).toContain("not enough data");
    expect(renderToStaticMarkup(<Sparkline label="X" values={[0, 0, 0]} />)).toContain("<path");
    expect(renderToStaticMarkup(<HBar label="L" items={[]} />)).toContain("<svg");
    expect(renderToStaticMarkup(<Gauge value={500} label="G" />)).toContain("100");
  });

  it("CIF table shows 90% intervals and marks missing ones", () => {
    const pt = (p: number, lo?: number, hi?: number) => ({ month: 3, p, lo, hi });
    render(
      <CifTable
        rows={[
          { month: 3, target: pt(0.1, 0.05, 0.2), bust: pt(0.02), stalled: pt(0.3, 0.2, 0.4) },
        ]}
      />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("10% (5% to 20%)")).toBeTruthy();
    expect(within(table).getByText("2% (not measured)")).toBeTruthy();
  });
});

describe("TimeSeriesChart", () => {
  it("renders without any network access and bundles the library", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<TimeSeriesChart data={days} label="BHP close" />);
    const lc = await import("lightweight-charts");
    await waitFor(() => expect(lc.createChart).toHaveBeenCalled());
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("has an accessible name, a summary, attribution and a table toggle", () => {
    render(<TimeSeriesChart data={days} label="BHP close" />);
    expect(screen.getByRole("img", { name: /BHP close, 6M: \d+ end-of-day prices/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /TradingView Lightweight Charts/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show as table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row").length).toBeGreaterThan(30);
    expect(screen.queryByTestId("ts-chart")).toBeNull();
  });

  it("limits ranges and scrubs by keyboard", () => {
    render(<TimeSeriesChart data={days} label="BHP close" />);
    fireEvent.click(screen.getByRole("button", { name: "1M" }));
    const chart = screen.getByTestId("ts-chart");
    const before = chart.getAttribute("aria-label");
    expect(before).toMatch(/1M: 3\d end-of-day/);
    const readout = () => document.querySelector("[aria-live]")!.textContent;
    const start = readout();
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(readout()).not.toBe(start);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(readout()).toContain(days[88]!.time);
  });

  it("reads tokens from the document and re-themes when data-theme changes", async () => {
    document.documentElement.style.setProperty("--color-chart-1", "rgb(1, 2, 3)");
    expect(readChartTheme().line).toBe("rgb(1, 2, 3)");
    render(<TimeSeriesChart data={days} label="BHP close" />);
    const lc = await import("lightweight-charts");
    await waitFor(() => expect(lc.createChart).toHaveBeenCalled());
    await waitFor(() => expect(remove).not.toHaveBeenCalled());
    document.documentElement.style.setProperty("--color-chart-1", "rgb(9, 9, 9)");
    document.documentElement.setAttribute("data-theme", "dark");
    await waitFor(() => expect(applyOptions).toHaveBeenCalled());
    expect(seriesApply).toHaveBeenCalledWith({ color: "rgb(9, 9, 9)" });
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.removeProperty("--color-chart-1");
  });
});
