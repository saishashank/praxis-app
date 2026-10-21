"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChartTable } from "./ChartTable";
import { n } from "./format";

/**
 * Interactive price chart (Lightweight Charts, Apache-2.0; see NOTICE and attribution below).
 * End-of-day data only (D-128): `time` is a calendar day "YYYY-MM-DD". Client-only; the canvas is
 * not readable by screen readers, so a summary, a keyboard scrub readout and a data table
 * ("Show as table") are always present. No network access: the library is bundled.
 */
export type TimePoint = { time: string; value: number };
export type Range = "1M" | "3M" | "6M" | "1Y" | "2Y";
export const RANGES: Range[] = ["1M", "3M", "6M", "1Y", "2Y"];
const RANGE_DAYS: Record<Range, number> = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "2Y": 731 };

/** Resolve the chart tokens from the live theme (re-read on theme change). */
export function readChartTheme(el: Element = document.documentElement) {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    line: v("--color-chart-1", "#1b6aa5"),
    area: v("--color-chart-2", "#7a4fc4"),
    grid: v("--color-grid", "#788296"),
    text: v("--color-text", "#111111"),
    surface: v("--color-surface", "#ffffff"),
  };
}

export function TimeSeriesChart({
  data,
  label,
  kind = "line",
  initialRange = "6M",
  currency = "A$",
}: {
  data: TimePoint[];
  label: string;
  kind?: "line" | "area";
  initialRange?: Range;
  currency?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>(initialRange);
  const [asTable, setAsTable] = useState(false);
  const [cursor, setCursor] = useState(data.length - 1);

  const shown = useMemo(() => {
    const last = data[data.length - 1];
    if (!last) return [];
    const cutoff = new Date(`${last.time}T00:00:00Z`).getTime() - RANGE_DAYS[range] * 86_400_000;
    return data.filter((p) => new Date(`${p.time}T00:00:00Z`).getTime() >= cutoff);
  }, [data, range]);

  const safeCursor = Math.min(Math.max(cursor, 0), Math.max(0, shown.length - 1));
  const at = shown[safeCursor];
  const first = shown[0];
  const last = shown[shown.length - 1];
  const summary =
    first && last
      ? `${label}, ${range}: ${shown.length} end-of-day prices from ${first.time} (${currency}${n(first.value)}) to ${last.time} (${currency}${n(last.value)}).`
      : `${label}: no price data`;

  useEffect(() => {
    const el = host.current;
    if (!el || shown.length === 0) return;
    let disposed = false;
    let cleanup = () => {};
    void import("lightweight-charts").then((lc) => {
      if (disposed || !host.current) return;
      const t = readChartTheme();
      const chart = lc.createChart(el, {
        autoSize: true,
        height: 240,
        layout: {
          background: { type: lc.ColorType.Solid, color: t.surface },
          textColor: t.text,
          attributionLogo: true,
        },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.grid },
        timeScale: { borderColor: t.grid },
        handleScroll: false,
        handleScale: false,
      });
      const series =
        kind === "area"
          ? chart.addSeries(lc.AreaSeries, {
              lineColor: t.line,
              topColor: t.area,
              bottomColor: t.surface,
            })
          : chart.addSeries(lc.LineSeries, { color: t.line, lineWidth: 2 });
      series.setData(shown);
      chart.timeScale().fitContent();

      // Re-theme when data-theme changes on <html> (dark/light/… switching without a reload).
      const mo = new MutationObserver(() => {
        const nt = readChartTheme();
        chart.applyOptions({
          layout: {
            background: { type: lc.ColorType.Solid, color: nt.surface },
            textColor: nt.text,
          },
          grid: { vertLines: { color: nt.grid }, horzLines: { color: nt.grid } },
          rightPriceScale: { borderColor: nt.grid },
          timeScale: { borderColor: nt.grid },
        });
        series.applyOptions(
          kind === "area"
            ? { lineColor: nt.line, topColor: nt.area, bottomColor: nt.surface }
            : { color: nt.line },
        );
      });
      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "class"],
      });
      cleanup = () => {
        mo.disconnect();
        chart.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [shown, kind]);

  function onKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowLeft") setCursor(Math.max(0, safeCursor - step));
    else if (e.key === "ArrowRight") setCursor(Math.min(shown.length - 1, safeCursor + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(shown.length - 1);
    else return;
    e.preventDefault();
  }

  return (
    <figure className="m-0" aria-label={label}>
      <div role="group" aria-label={`${label} range`} className="flex gap-2 mb-2">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={r === range}
            onClick={() => {
              setRange(r);
              setCursor(Number.MAX_SAFE_INTEGER);
            }}
            className="min-h-6 min-w-6 px-2 border"
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
          className="ml-auto min-h-6 px-2 border"
        >
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>

      {!asTable && (
        <div
          ref={host}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={onKey}
          data-testid="ts-chart"
          style={{ minHeight: 240 }}
        />
      )}
      <p aria-live="polite" className="text-sm font-mono">
        {at
          ? `${at.time}: ${currency}${n(at.value)} (use left and right arrow keys to move)`
          : "No price data"}
      </p>
      {asTable ? (
        <ChartTable
          visible
          caption={summary}
          headers={["Date", `Close (${currency})`]}
          rows={shown.map((p) => [p.time, n(p.value)])}
        />
      ) : (
        <p className="sr-only">{summary}</p>
      )}
      <figcaption className="text-xs">
        Charts by{" "}
        <a href="https://www.tradingview.com/" rel="noopener noreferrer" target="_blank">
          TradingView Lightweight Charts
        </a>
        . End-of-day prices.
      </figcaption>
    </figure>
  );
}
