// @vitest-environment jsdom
// UXR-022: candles take the outcome tokens, the volume takes the sector hue at 40 %, and the range chip
// that is on carries a check icon as well as its fill.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const series = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; opts: unknown }> }));
vi.mock("lightweight-charts", () => ({
  ColorType: { Solid: "solid" },
  LineSeries: "line",
  CandlestickSeries: "candles",
  HistogramSeries: "histogram",
  createSeriesMarkers: vi.fn(),
  createChart: () => ({
    addSeries: (kind: string, opts: unknown) => {
      series.calls.push({ kind, opts });
      return { setData: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) };
    },
    timeScale: () => ({ fitContent: vi.fn() }),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
  }),
}));

import { CompanyChart, withAlpha } from "@/app/(app)/market/CompanyChart";

const bars = [
  { time: "2026-10-27", o: 1_000_000, h: 1_100_000, l: 900_000, c: 1_050_000, volume: 100 },
  { time: "2026-10-28", o: 1_050_000, h: 1_100_000, l: 950_000, c: 1_000_000, volume: 200 },
];

beforeEach(() => {
  series.calls = [];
  const r = document.documentElement.style;
  r.setProperty("--color-positive-fill", "#58ebc0");
  r.setProperty("--color-negative-fill", "#fb7360");
  r.setProperty("--color-sector-tech-fill", "#59c7b4");
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

describe("withAlpha", () => {
  it("turns a hex token into rgba and leaves other strings alone", () => {
    expect(withAlpha("#59c7b4", 0.4)).toBe("rgba(89, 199, 180, 0.4)");
    expect(withAlpha("#fff", 0.4)).toBe("rgba(255, 255, 255, 0.4)");
    expect(withAlpha("rgb(1 2 3)", 0.4)).toBe("rgb(1 2 3)");
  });
});

describe("CompanyChart colours", () => {
  it("candles use the outcome tokens and the volume uses the sector hue at 40 %", async () => {
    render(<CompanyChart bars={bars} markers={[]} label="Zed" hue="sector-tech" />);
    await waitFor(() => expect(series.calls.length).toBeGreaterThanOrEqual(2));
    const candles = series.calls.find((c) => c.kind === "candles")!.opts as Record<string, string>;
    expect(candles.upColor).toBe("#58ebc0");
    expect(candles.downColor).toBe("#fb7360");
    expect(candles.wickUpColor).toBe("#58ebc0");
    expect(candles.borderDownColor).toBe("#fb7360");
    const vol = series.calls.find((c) => c.kind === "histogram")!.opts as Record<string, string>;
    expect(vol.color).toBe("rgba(89, 199, 180, 0.4)");
  });

  it("the chosen range chip has a check icon, a fill and aria-pressed", () => {
    render(<CompanyChart bars={bars} markers={[]} label="Zed" />);
    const group = screen.getByRole("group", { name: "Chart range" });
    const on = within(group).getByRole("button", { name: "6M" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(on.querySelector("svg")).not.toBeNull();
    expect(within(group).getByRole("button", { name: "1M" }).querySelector("svg")).toBeNull();
  });
});
