"use client";
// The NAV chart of one strategy with trade markers, a linked trade strip, matched controls and the
// zero-edge benchmark, and the drawdown chart below it (UXN-051, UXN-054, UXN-055, UXN-068; UX-030,
// UX-031). End-of-day data only, from the stored nightly series; nothing is computed in the request.
// Lightweight Charts draws on a canvas, so a text readout (arrow keys scrub it), a "Show as table"
// switch and a summary are always there. Colours come from the chart tokens (never a red and green
// pair); entries and exits differ by shape and by the words "Buy" and "Sell". A masked viewer gets no
// markers (they would give exact trade dates away) and a strip with weeks only.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChartTable } from "@/components/charts/ChartTable";
import { formatCents, gainLossGlyph } from "@/lib/view/format";
import { regimeLabel } from "@/lib/view/terms";

export type ChartPoint = { time: string; value: number };
export type ChartTrade = {
  key: string;
  stock: string;
  entryDate: string | null;
  exitDate: string | null;
  entryDay: string | null;
  exitDay: string | null;
  qty: number;
  open: boolean;
  returnText: string | null;
  pnlText: string | null;
  entryPriceText: string | null;
  exitPriceText: string | null;
  cardHref: string | null;
};
export type ChartControl = { id: string; label: string; points: ChartPoint[] };

type Tokens = {
  line: string;
  c2: string;
  c3: string;
  c4: string;
  grid: string;
  text: string;
  surface: string;
  amber: string;
};

function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    line: v("--color-chart-1", "currentColor"),
    c2: v("--color-chart-2", "currentColor"),
    c3: v("--color-chart-3", "currentColor"),
    c4: v("--color-chart-4", "currentColor"),
    grid: v("--color-grid", "currentColor"),
    text: v("--color-text", "currentColor"),
    surface: v("--color-surface", "transparent"),
    amber: v("--color-breaker-amber", "currentColor"),
  };
}

/** The time the chart hands back, as "YYYY-MM-DD" (a string or a business-day object). */
function timeKey(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (typeof t === "object" && t !== null) {
    const o = t as { year?: number; month?: number; day?: number };
    if (o.year && o.month && o.day) {
      return `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`;
    }
  }
  return null;
}

const dollars = (v: number): string => formatCents(Math.round(v * 100));

/** Re-reads the chart tokens when the theme attribute of <html> changes. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setTick((n) => n + 1));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => mo.disconnect();
  }, []);
  return tick;
}

export function StrategyChart({
  name,
  nav,
  regimes,
  controls,
  zeroEdge,
  lines,
  trades,
  showMarkers,
  drawdown,
  maxDropText,
}: {
  name: string;
  nav: ChartPoint[];
  regimes: Array<string | null>;
  controls: ChartControl[];
  zeroEdge: { level: number; text: string } | null;
  lines: { seed: number | null; bust: number | null; target: number | null };
  trades: ChartTrade[];
  showMarkers: boolean;
  drawdown: ChartPoint[];
  maxDropText: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ddHost = useRef<HTMLDivElement>(null);
  const [compare, setCompare] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [cursor, setCursor] = useState(Math.max(0, nav.length - 1));
  const [selected, setSelected] = useState<string | null>(null);
  const tick = useThemeTick();
  const [lc, setLc] = useState<typeof import("lightweight-charts") | null>(null);
  useEffect(() => {
    let on = true;
    void import("lightweight-charts").then((m) => {
      if (on) setLc(m);
    });
    return () => {
      on = false;
    };
  }, []);

  const index = useMemo(() => new Map(nav.map((p, i) => [p.time, i])), [nav]);
  const safe = Math.min(Math.max(cursor, 0), Math.max(0, nav.length - 1));
  const at = nav[safe];
  const prev = nav[safe - 1];
  const mood = regimes[safe] ?? null;
  const selectedTrade = trades.find((t) => t.key === selected) ?? null;
  const selectedIdx = trades.findIndex((t) => t.key === selected);

  const summary = nav.length
    ? `${name} value: ${nav.length} end-of-day values from ${nav[0]!.time} (${dollars(nav[0]!.value)}) to ${nav[nav.length - 1]!.time} (${dollars(nav[nav.length - 1]!.value)}).`
    : `${name} value: no data yet`;

  useEffect(() => {
    const el = host.current;
    if (!el || nav.length === 0 || asTable) return;
    if (!lc) return;
    let cleanup = () => {};
    {
      const t = readTokens();
      const chart = lc.createChart(el, {
        autoSize: true,
        height: 260,
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
      const series = chart.addSeries(lc.LineSeries, { color: t.line, lineWidth: 2 });
      series.setData(nav);
      const level = (price: number | null, title: string) => {
        if (price === null) return;
        series.createPriceLine({
          price,
          title,
          color: t.grid,
          lineWidth: 1,
          lineStyle: lc.LineStyle.Dotted,
          axisLabelVisible: true,
        });
      };
      level(lines.seed, "Start");
      level(lines.bust, "Loss limit");
      level(lines.target, "Goal");
      if (compare) {
        const colours = [t.c2, t.c3, t.c4];
        controls.forEach((c, i) => {
          const s = chart.addSeries(lc.LineSeries, {
            color: colours[i % colours.length]!,
            lineWidth: 1,
            lineStyle: lc.LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          s.setData(c.points);
        });
        if (zeroEdge) {
          series.createPriceLine({
            price: zeroEdge.level,
            title: "Zero-edge benchmark",
            color: t.amber,
            lineWidth: 2,
            lineStyle: lc.LineStyle.LargeDashed,
            axisLabelVisible: true,
          });
        }
      }
      if (showMarkers) {
        const markers = trades.flatMap((tr) => {
          const hot = tr.key === selected;
          const out: Array<{
            time: string;
            position: "belowBar" | "aboveBar";
            shape: "arrowUp" | "arrowDown";
            color: string;
            text: string;
            size: number;
          }> = [];
          if (tr.entryDate)
            out.push({
              time: tr.entryDate,
              position: "belowBar",
              shape: "arrowUp",
              color: t.c4,
              text: hot ? `Buy ${tr.stock}` : "Buy",
              size: hot ? 2 : 1,
            });
          if (tr.exitDate)
            out.push({
              time: tr.exitDate,
              position: "aboveBar",
              shape: "arrowDown",
              color: t.c2,
              text: hot ? `Sell ${tr.stock}` : "Sell",
              size: hot ? 2 : 1,
            });
          return out;
        });
        markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        lc.createSeriesMarkers(series, markers);
      }
      chart.timeScale().fitContent();
      const onMove = (p: { time?: unknown }) => {
        const k = timeKey(p.time);
        const i = k === null ? undefined : index.get(k);
        if (i !== undefined) setCursor(i);
      };
      const onClick = (p: { time?: unknown }) => {
        const k = timeKey(p.time);
        if (k === null) return;
        const hit = trades.find((tr) => tr.entryDate === k || tr.exitDate === k);
        if (hit) setSelected(hit.key);
      };
      chart.subscribeCrosshairMove(onMove);
      chart.subscribeClick(onClick);
      cleanup = () => {
        chart.unsubscribeCrosshairMove(onMove);
        chart.unsubscribeClick(onClick);
        chart.remove();
      };
    }
    return () => cleanup();
  }, [
    lc,
    nav,
    compare,
    controls,
    zeroEdge,
    lines,
    trades,
    showMarkers,
    selected,
    asTable,
    index,
    tick,
  ]);

  useEffect(() => {
    const el = ddHost.current;
    if (!el || drawdown.length === 0 || asTable) return;
    if (!lc) return;
    let cleanup = () => {};
    {
      const t = readTokens();
      const chart = lc.createChart(el, {
        autoSize: true,
        height: 140,
        layout: {
          background: { type: lc.ColorType.Solid, color: t.surface },
          textColor: t.text,
          attributionLogo: false,
        },
        grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
        rightPriceScale: { borderColor: t.grid },
        timeScale: { borderColor: t.grid },
        handleScroll: false,
        handleScale: false,
      });
      const s = chart.addSeries(lc.AreaSeries, {
        lineColor: t.amber,
        topColor: t.surface,
        bottomColor: t.amber,
        priceFormat: { type: "custom", formatter: (v: number) => `${v.toFixed(1)}%`, minMove: 0.1 },
      });
      s.setData(drawdown);
      chart.timeScale().fitContent();
      cleanup = () => chart.remove();
    }
    return () => cleanup();
  }, [lc, drawdown, asTable, tick]);

  function onKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowLeft") setCursor(Math.max(0, safe - step));
    else if (e.key === "ArrowRight") setCursor(Math.min(nav.length - 1, safe + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(nav.length - 1);
    else return;
    e.preventDefault();
  }

  function pick(key: string) {
    setSelected(key);
    const tr = trades.find((x) => x.key === key);
    const i = tr?.entryDate ? index.get(tr.entryDate) : undefined;
    if (i !== undefined) setCursor(i);
  }

  function step(delta: number) {
    if (trades.length === 0) return;
    const next =
      selectedIdx < 0
        ? delta > 0
          ? 0
          : trades.length - 1
        : (selectedIdx + delta + trades.length) % trades.length;
    pick(trades[next]!.key);
  }

  const dayChange = at && prev ? Math.round((at.value - prev.value) * 100) : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <figure className="m-0 min-w-0" aria-label={`${name} value over time`}>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={compare}
            onClick={() => setCompare((v) => !v)}
            disabled={controls.length === 0 && !zeroEdge}
            className="min-h-6 rounded-md border border-border px-3 py-1 text-sm"
          >
            Compare with matched controls
          </button>
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            className="ml-auto min-h-6 rounded-md border border-border px-3 py-1 text-sm"
          >
            {asTable ? "Show chart" : "Show as table"}
          </button>
        </div>
        {controls.length === 0 && !zeroEdge ? (
          <p className="m-0 mb-2 text-xs text-text-muted">
            Matched controls and the zero-edge benchmark: Not measured yet.
          </p>
        ) : null}
        {compare ? (
          <ul className="m-0 mb-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
            {controls.map((c) => (
              <li key={c.id}>{c.label} (dashed line)</li>
            ))}
            {zeroEdge ? <li>{zeroEdge.text}</li> : null}
          </ul>
        ) : null}
        {asTable ? (
          <ChartTable
            visible
            caption={summary}
            headers={["Date", "Value (A$)", "Market mood"]}
            rows={nav.map((p, i) => [p.time, p.value.toFixed(2), regimes[i] ?? "n/a"])}
          />
        ) : (
          <div
            ref={host}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKey}
            data-testid="nav-chart"
            style={{ minHeight: 260 }}
          />
        )}
        <p aria-live="polite" className="m-0 mt-2 text-sm font-mono">
          {at
            ? `${at.time}: ${dollars(at.value)}${
                dayChange !== null
                  ? `, ${gainLossGlyph(dayChange)} ${formatCents(dayChange, { sign: "always" })} on the day`
                  : ""
              }${mood ? `, market mood ${regimeLabel(mood).shown} (${mood})` : ""} (arrow keys move along the line)`
            : "No values yet"}
        </p>
        <figcaption className="text-xs text-text-muted">
          Charts by{" "}
          <a
            href="https://www.tradingview.com/"
            rel="noopener noreferrer"
            target="_blank"
            className="underline"
          >
            TradingView Lightweight Charts
          </a>
          . End-of-day values, simulated.
        </figcaption>
      </figure>

      <section aria-labelledby="dd-h" className="min-w-0">
        <h3 id="dd-h" className="m-0 text-base font-semibold">
          Drop from the highest value so far
        </h3>
        <p className="m-0 mb-2 text-sm text-text-muted">{maxDropText}</p>
        {!asTable ? (
          <div
            ref={ddHost}
            role="img"
            aria-label={`${name}: drop from the highest value so far. ${maxDropText}`}
            style={{ minHeight: 140 }}
          />
        ) : (
          <ChartTable
            visible
            caption="Drop from the highest value so far"
            headers={["Date", "Drop (%)"]}
            rows={drawdown.map((p) => [p.time, p.value.toFixed(2)])}
          />
        )}
      </section>

      <section aria-labelledby="strip-h" className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="strip-h" className="m-0 text-base font-semibold">
            Trades in this round
          </h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={trades.length === 0}
              className="min-h-6 rounded-md border border-border px-3 py-1 text-sm"
            >
              Previous trade
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={trades.length === 0}
              className="min-h-6 rounded-md border border-border px-3 py-1 text-sm"
            >
              Next trade
            </button>
          </div>
        </div>
        {!showMarkers ? (
          <p className="m-0 mt-1 text-xs text-text-muted">
            Trade markers on the chart are for the Owner and unmasked users. Here dates show as
            weeks and prices are hidden.
          </p>
        ) : null}
        {trades.length === 0 ? (
          <p className="m-0 mt-2 text-sm text-text-muted">No trades in this round yet.</p>
        ) : (
          <ol
            aria-label="Trades, newest first"
            className="m-0 mt-2 flex list-none gap-2 overflow-x-auto p-0 pb-2 max-sm:snap-x"
          >
            {trades.map((tr) => (
              <li key={tr.key} className="min-w-44 shrink-0 snap-start">
                <button
                  type="button"
                  aria-pressed={tr.key === selected}
                  onClick={() => pick(tr.key)}
                  className={`w-full min-w-0 break-words rounded-lg border p-2 text-left text-sm ${tr.key === selected ? "border-accent bg-surface-2" : "border-border bg-surface"}`}
                >
                  <span className="block font-semibold">{tr.stock}</span>
                  <span className="block text-xs text-text-muted">
                    {tr.entryDay ?? "n/a"}
                    {tr.exitDay ? ` to ${tr.exitDay}` : " (open)"}
                  </span>
                  <span className="block font-mono">{tr.returnText ?? "Open"}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {selectedTrade ? (
          <div
            role="region"
            aria-label="Selected trade"
            aria-live="polite"
            className="mt-2 rounded-lg border border-border bg-surface p-3 text-sm break-words"
          >
            <p className="m-0 font-semibold">{selectedTrade.stock}</p>
            <dl className="m-0 mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-text-muted">Bought</dt>
              <dd className="m-0 text-right font-mono">{selectedTrade.entryDay ?? "n/a"}</dd>
              <dt className="text-text-muted">Sold</dt>
              <dd className="m-0 text-right font-mono">{selectedTrade.exitDay ?? "Still open"}</dd>
              <dt className="text-text-muted">Size</dt>
              <dd className="m-0 text-right font-mono">{selectedTrade.qty} shares</dd>
              {selectedTrade.entryPriceText ? (
                <>
                  <dt className="text-text-muted">Buy price</dt>
                  <dd className="m-0 text-right font-mono">{selectedTrade.entryPriceText}</dd>
                </>
              ) : null}
              {selectedTrade.exitPriceText ? (
                <>
                  <dt className="text-text-muted">Sell price</dt>
                  <dd className="m-0 text-right font-mono">{selectedTrade.exitPriceText}</dd>
                </>
              ) : null}
              <dt className="text-text-muted">Result</dt>
              <dd className="m-0 text-right font-mono">
                {selectedTrade.pnlText ?? selectedTrade.returnText ?? "Open"}
              </dd>
            </dl>
            {selectedTrade.cardHref ? (
              <Link
                href={selectedTrade.cardHref}
                className="mt-2 inline-block text-accent underline"
              >
                Why this trade (Decision Card)
              </Link>
            ) : (
              <p className="m-0 mt-2 text-text-muted">No Decision Card is stored for this trade.</p>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
