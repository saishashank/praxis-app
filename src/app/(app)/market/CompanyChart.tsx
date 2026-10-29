"use client";
// Company chart (UXN-271): daily candles with a volume histogram, range chips 1M..2Y, optional 50- and
// 200-day moving averages, a line toggle, a crosshair readout (date, open, high, low, close, volume) and
// markers for our practice trades, picks and announcement days. End-of-day data only; no network use
// (the library is bundled, canvas drawing only, CSP-safe). The canvas is invisible to screen readers, so
// a summary, a keyboard readout (arrow keys) and a "Show as table" view are always available.
// Only unmasked users ever receive bars (DAT-124); this component is never rendered for a masked user.
// Lightweight Charts is Apache-2.0: the on-chart attribution logo and the link below satisfy its NOTICE.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartTable } from "@/components/charts/ChartTable";
import { CheckIcon } from "@/components/ui/icons";
import { formatCount, formatMicro } from "@/lib/view/format";

// Same shapes as the company loader's CandleBar and ChartMarker (a client file may not import the loaders).
type CandleBar = { time: string; o: number; h: number; l: number; c: number; volume: number };
type ChartMarker = { time: string; kind: "buy" | "sell" | "pick" | "news"; text: string };

const RANGES = ["1M", "3M", "6M", "1Y", "2Y"] as const;
type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "2Y": 731 };
const MS_DAY = 86_400_000; // threshold-ok: milliseconds per day
const MICRO = 1_000_000; // threshold-ok: micro units per unit
const MA_DAYS = [50, 200] as const; // threshold-ok: UXN-271 moving averages
const CHART_HEIGHT = 280; // threshold-ok: design 3 row 9, 280 px on phones

const px = (micro: number): number => micro / MICRO; // money-float-ok: chart axis value, display only

const VOLUME_ALPHA = 0.4; // threshold-ok: UXR-022 volume bars at 40 % of the sector hue

/** "#rrggbb" or "#rgb" to rgba(...) at the given alpha; any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return `rgba(${v(0)}, ${v(2)}, ${v(4)}, ${alpha})`;
}

/** Colours from the V2 tokens (D-208): candles in the outcome pair, volume in the sector hue at 40 %. */
function tokens(hue: string | null) {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const up = v("--color-positive-fill", v("--color-positive", "#0b7a6c"));
  const down = v("--color-negative-fill", v("--color-negative", "#b0440c"));
  const volBase = hue
    ? v(`--color-${hue}-fill`, v("--color-chart-2", "#7a4fc4"))
    : v("--color-chart-2", "#7a4fc4");
  return {
    up,
    down,
    line: v("--color-chart-1", "#1b6aa5"),
    vol: withAlpha(volBase, VOLUME_ALPHA),
    ma50: v("--color-chart-3", "#9a6a00"),
    ma200: v("--color-chart-4", "#2a7f52"),
    grid: v("--color-grid", "#788296"),
    text: v("--color-text", "#111111"),
    surface: v("--color-surface", "#ffffff"),
  };
}

function movingAverage(bars: CandleBar[], days: number): Array<{ time: string; value: number }> {
  const out: Array<{ time: string; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i]!.c;
    if (i >= days) sum -= bars[i - days]!.c;
    if (i >= days - 1) out.push({ time: bars[i]!.time, value: px(sum / days) }); // money-float-ok: chart overlay
  }
  return out;
}

export function CompanyChart({
  bars,
  markers,
  label,
  hue = null,
}: {
  bars: CandleBar[];
  markers: ChartMarker[];
  label: string;
  /** The company's sector hue token stem, e.g. "sector-tech"; volume bars use it at 40 %. */
  hue?: string | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<Range>("6M");
  const [line, setLine] = useState(false);
  const [ma, setMa] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [cursor, setCursor] = useState(Number.MAX_SAFE_INTEGER);

  const shown = useMemo(() => {
    const last = bars[bars.length - 1];
    if (!last) return [];
    const cutoff = Date.parse(`${last.time}T00:00:00Z`) - RANGE_DAYS[range] * MS_DAY;
    return bars.filter((b) => Date.parse(`${b.time}T00:00:00Z`) >= cutoff);
  }, [bars, range]);

  const at = shown[Math.min(Math.max(cursor, 0), Math.max(0, shown.length - 1))];
  const first = shown[0];
  const last = shown[shown.length - 1];
  const summary =
    first && last
      ? `${label}, ${range}: ${shown.length} end-of-day bars from ${first.time} (close ${formatMicro(first.c)}) to ${last.time} (close ${formatMicro(last.c)}).`
      : `${label}: no price data`;

  useEffect(() => {
    const el = host.current;
    if (!el || shown.length === 0 || asTable) return;
    let disposed = false;
    let cleanup = () => {};
    void import("lightweight-charts").then((lc) => {
      if (disposed || !host.current) return;
      const t = tokens(hue);
      const chart = lc.createChart(el, {
        autoSize: true,
        height: CHART_HEIGHT,
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
      const price = line
        ? chart.addSeries(lc.LineSeries, { color: t.line, lineWidth: 2 })
        : chart.addSeries(lc.CandlestickSeries, {
            upColor: t.up,
            downColor: t.down,
            borderUpColor: t.up,
            borderDownColor: t.down,
            wickUpColor: t.up,
            wickDownColor: t.down,
          });
      if (line) {
        price.setData(shown.map((b) => ({ time: b.time, value: px(b.c) })));
      } else {
        price.setData(
          shown.map((b) => ({
            time: b.time,
            open: px(b.o),
            high: px(b.h),
            low: px(b.l),
            close: px(b.c),
          })),
        );
      }
      price.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.28 } });
      const vol = chart.addSeries(lc.HistogramSeries, {
        color: t.vol,
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      vol.setData(shown.map((b) => ({ time: b.time, value: b.volume })));
      if (ma) {
        for (const days of MA_DAYS) {
          const s = chart.addSeries(lc.LineSeries, {
            color: days === MA_DAYS[0] ? t.ma50 : t.ma200,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          const from = shown[0]!.time;
          s.setData(movingAverage(bars, days).filter((p) => p.time >= from));
        }
      }
      const inRange = new Set(shown.map((b) => b.time));
      const marks = markers
        .filter((m) => inRange.has(m.time))
        .map((m) => ({
          time: m.time,
          position: m.kind === "sell" ? ("aboveBar" as const) : ("belowBar" as const),
          shape:
            m.kind === "buy"
              ? ("arrowUp" as const)
              : m.kind === "sell"
                ? ("arrowDown" as const)
                : m.kind === "pick"
                  ? ("square" as const)
                  : ("circle" as const),
          color: m.kind === "news" ? t.ma50 : m.kind === "pick" ? t.line : t.text,
          text: m.kind === "buy" ? "B" : m.kind === "sell" ? "S" : m.kind === "pick" ? "P" : "N",
        }));
      if (marks.length > 0) lc.createSeriesMarkers(price, marks);
      chart.timeScale().fitContent();
      const byTime = new Map(shown.map((b, i) => [b.time, i]));
      const onMove = (p: { time?: unknown }) => {
        const i = typeof p.time === "string" ? byTime.get(p.time) : undefined;
        if (i !== undefined) setCursor(i);
      };
      chart.subscribeCrosshairMove(onMove);
      cleanup = () => {
        chart.unsubscribeCrosshairMove(onMove);
        chart.remove();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [shown, bars, markers, line, ma, asTable, hue]);

  function onKey(e: React.KeyboardEvent) {
    const i = Math.min(Math.max(cursor, 0), Math.max(0, shown.length - 1));
    const step = e.shiftKey ? 5 : 1; // threshold-ok: Shift jumps five bars
    if (e.key === "ArrowLeft") setCursor(Math.max(0, i - step));
    else if (e.key === "ArrowRight") setCursor(Math.min(shown.length - 1, i + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(shown.length - 1);
    else return;
    e.preventDefault();
  }

  const chip = "min-h-6 min-w-6 rounded-md border border-border px-2 text-sm";
  return (
    <figure className="m-0 min-w-0" aria-label={`${label} price chart`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Chart range" className="flex gap-2 overflow-x-auto">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={r === range}
              onClick={() => {
                setRange(r);
                setCursor(Number.MAX_SAFE_INTEGER);
              }}
              className={
                chip +
                " inline-flex items-center gap-1" +
                (r === range ? " bg-accent text-accent-contrast font-semibold" : " bg-surface")
              }
            >
              {r === range ? <CheckIcon aria-hidden="true" /> : null}
              {r}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={line}
          onClick={() => setLine((v) => !v)}
          className={chip}
        >
          Line chart
        </button>
        <button type="button" aria-pressed={ma} onClick={() => setMa((v) => !v)} className={chip}>
          Moving averages
        </button>
        <button
          type="button"
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
          className={chip + " ml-auto"}
        >
          {asTable ? "Show chart" : "Show as table"}
        </button>
      </div>
      {!asTable && (
        <div
          ref={host}
          role="group"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={onKey}
          data-testid="company-chart"
          style={{ minHeight: CHART_HEIGHT }}
        />
      )}
      <p aria-live="polite" className="m-0 mt-1 break-words font-sans text-sm tabular-nums">
        {at
          ? `${at.time}  open ${formatMicro(at.o)}  high ${formatMicro(at.h)}  low ${formatMicro(at.l)}  close ${formatMicro(at.c)}  volume ${formatCount(at.volume)}`
          : "No price data"}
        {at ? " (left and right arrow keys move the readout)" : ""}
      </p>
      {asTable ? (
        <ChartTable
          visible
          caption={summary}
          headers={["Date", "Open", "High", "Low", "Close", "Volume"]}
          rows={shown
            .slice()
            .reverse()
            .map((b) => [
              b.time,
              formatMicro(b.o),
              formatMicro(b.h),
              formatMicro(b.l),
              formatMicro(b.c),
              formatCount(b.volume),
            ])}
        />
      ) : (
        <p className="sr-only">{summary}</p>
      )}
      <figcaption className="mt-1 text-xs text-text-muted">
        Markers: B = a practice strategy bought, S = sold, P = a pick, N = an announcement day.
        End-of-day prices. Charts by{" "}
        <a href="https://www.tradingview.com/" rel="noopener noreferrer" target="_blank">
          TradingView Lightweight Charts
        </a>
        .
      </figcaption>
    </figure>
  );
}
