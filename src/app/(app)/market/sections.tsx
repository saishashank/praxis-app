// The Market page sections (D-205, Owner 2026-10-29): each reads its data from a promise the page
// starts, inside its own Suspense boundary, so the header, search and other sections show at once and
// each section appears when its data is ready, with a loading spinner until then. A collapsed section
// renders only its heading and starts no data load.
import Link from "next/link";
import { use, type ReactNode } from "react";
import { Sparkline } from "@/components/charts/Sparkline";
import { SectorHeatGrid } from "@/components/charts/Grids";
import { Banner, EmptyState } from "@/components/ui/States";
import { Chips } from "@/components/ui/Nav";
import { Segmented } from "@/components/ui/Segmented";
import type { IndexStrip } from "@/lib/ui/loaders/company";
import {
  marketHref,
  type MarketList,
  type MarketModel,
  type MarketQuery,
  type MarketSection,
} from "@/lib/ui/loaders/market";
import { Change } from "./Figures";
import { MarketTable } from "./MarketTable";
import type { WatchResult } from "./messages";
import type { WatchMode } from "./RowActions";
import { sectorKey } from "./sectorHue";
import { formatDay, formatPpm } from "@/lib/view/format";
import { formatIndexPoints, ppmToPercent } from "./text";

type Star = (fd: FormData) => Promise<WatchResult>;

/** The arriving layout, as grey bars (UXN-008, D-1232). */
export type SkeletonShape = "rows" | "tiles" | "chart";

const SKELETON_BAR = "rounded bg-surface-2";

/**
 * What a section shows while its data loads: grey bars in the shape of what is coming (rows of a list, tiles,
 * or a chart), with the label as the one status for a screen reader. Nothing is animated, so Motion: Off and
 * reduced motion need no switch (D-1232).
 */
export function SectionLoading({
  label,
  shape = "rows",
}: {
  label: string;
  shape?: SkeletonShape;
}) {
  return (
    <div role="status" className="py-3 text-sm text-text-muted">
      <div aria-hidden="true" data-skeleton-shape={shape} className="mb-2">
        {shape === "rows" ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} data-skeleton="bar" className={`${SKELETON_BAR} h-8 w-full`} />
            ))}
          </div>
        ) : shape === "tiles" ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} data-skeleton="bar" className={`${SKELETON_BAR} h-16`} />
            ))}
          </div>
        ) : (
          <div data-skeleton="bar" className={`${SKELETON_BAR} h-40 w-full`} />
        )}
      </div>
      {label}
    </div>
  );
}

/** A section heading that opens or closes the section by link (no data is loaded while closed). */
export function MarketSectionFrame({
  id,
  title,
  q,
  children,
}: {
  id: MarketSection;
  title: string;
  q: MarketQuery;
  children: ReactNode;
}) {
  const open = q.open.includes(id);
  const toggled = open ? q.open.filter((s) => s !== id) : [...q.open, id];
  return (
    <section
      aria-labelledby={`${id}-h`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <h2 id={`${id}-h`} className="m-0 flex items-center text-lg font-semibold">
        <Link
          href={marketHref(q, { open: toggled })}
          aria-expanded={open}
          scroll={false}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2"
        >
          <span aria-hidden="true" className={open ? "inline-block rotate-90" : "inline-block"}>
            ›
          </span>
          {title}
          <span className="ml-auto text-sm font-normal text-text-muted">
            {open ? "Hide" : "Show"}
          </span>
        </Link>
      </h2>
      {open ? children : null}
    </section>
  );
}

/** Previous / page n of m / next for one list; the other lists keep their pages. */
function Pager({
  label,
  list,
  hrefFor,
}: {
  label: string;
  list: MarketList;
  hrefFor: (page: number) => string;
}) {
  const { number, size, total } = list.page;
  const last = Math.max(1, Math.ceil(total / size));
  if (last <= 1) return null;
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-3 text-sm">
      {number > 1 ? (
        <Link href={hrefFor(number - 1)} scroll={false} className="text-accent underline">
          Previous page
        </Link>
      ) : (
        <span />
      )}
      <span>
        Page {Math.min(number, last)} of {last}
      </span>
      {number < last ? (
        <Link href={hrefFor(number + 1)} scroll={false} className="text-accent underline">
          Next page
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** "up 0.4 %", "down 0.3 %" or "unchanged": the day's move in words, from the stored ppm. */
function moveWords(ppm: number | null): string {
  if (ppm === null || !Number.isFinite(ppm)) return "no change yet";
  const pct = formatPpm(Math.abs(ppm));
  if (pct === formatPpm(0)) return "unchanged on the day";
  return `${ppm > 0 ? "up" : "down"} ${pct} on the day`;
}

/** The closes as a path from 100, so a masked user sees the shape and the move but not the index level (D-1255). */
function rebased(closes: number[]): number[] {
  const first = closes[0];
  return first === undefined || first === 0 ? [] : closes.map((c) => (c / first) * 100);
}

/**
 * The main index as a one-row table (UXN-321 item 13, D-1206): a screen-reader caption, the index name as the row
 * header, column headers, the sparkline, and one visible line saying level, move and freshness in trading words.
 * A masked user gets the change only (no index name, level or date).
 */
export function IndexSection({ index, masked }: { index: Promise<IndexStrip>; masked: boolean }) {
  const strip = use(index);
  if (!strip) {
    return (
      <p className="m-0 mt-1 text-sm text-text-muted">
        No index data has been stored yet. It appears after a nightly run.
      </p>
    );
  }
  const name = masked ? "Market index" : strip.label;
  const ppm = strip.live ? strip.live.changePpm : strip.changePpm;
  const level = formatIndexPoints(strip.live ? strip.live.levelMicro : strip.closeMicro);
  const fresh = strip.live
    ? `Delayed, ${strip.live.at}`
    : `End of day${masked ? "" : `, ${formatDay(strip.d)}`}`;
  return (
    <div className="mt-1 flex flex-col gap-2">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Main index, latest level and change</caption>
        <thead>
          <tr className="text-xs text-text-muted">
            <th scope="col" className="py-1 pr-3 font-medium">
              Index
            </th>
            {!masked ? (
              <th scope="col" className="py-1 pr-3 font-medium">
                Level
              </th>
            ) : null}
            <th scope="col" className="py-1 pr-3 font-medium">
              Change
            </th>
            <th scope="col" className="py-1 font-medium">
              Last month
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="py-1 pr-3 font-medium">
              {name}
            </th>
            {!masked ? <td className="py-1 pr-3 font-sans tabular-nums">{level}</td> : null}
            <td className="py-1 pr-3">
              <Change ppm={ppm} />
            </td>
            <td className="py-1">
              {masked ? (
                <Sparkline
                  values={rebased(strip.closes)}
                  label="Main index, last month (first day = 100)"
                  format={(v) => v.toFixed(1)}
                />
              ) : (
                <Sparkline
                  values={strip.closes}
                  label="Main index, last month"
                  format={formatIndexPoints}
                  labels={strip.dates.map((d) => formatDay(d))}
                />
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <p data-testid="index-summary" className="m-0 text-sm text-text-muted">
        {masked ? `${name}: ` : `${name}: ${level}, `}
        {moveWords(ppm)}. {fresh}.
      </p>
    </div>
  );
}

/** Latest data date, the out-of-date banner and the size switch. */
export function MarketStatus({ model, q }: { model: Promise<MarketModel>; q: MarketQuery }) {
  const m = use(model);
  const sizes = [
    { id: "all", label: "All" },
    { id: "large", label: "Large" },
    { id: "mid", label: "Mid" },
    { id: "small", label: "Small" },
  ] as const;
  return (
    <>
      {/* D-884: the day the prices are from, plainly at the top of the lists */}
      <p className="m-0 text-sm font-medium" data-prices-as-of="">
        {m.d
          ? m.masked
            ? "Last close (end of day)"
            : `Last close: ${formatDay(m.d)} (end of day)`
          : "No prices stored yet"}
      </p>
      {m.state === "stale" && m.staleText ? (
        <Banner tone="warning" title="Out of date">
          {m.staleText}
        </Banner>
      ) : null}
      {m.sized && !m.masked ? (
        <div className="flex flex-col gap-1">
          <Segmented
            label="Company size"
            value={m.size}
            items={sizes.map((z) => ({
              // a new size starts every list on its first page
              href: marketHref(q, { size: z.id, upPage: 1, downPage: 1, tradedPage: 1, page: 1 }),
              value: z.id,
              label: z.label,
            }))}
          />
          <p className="m-0 text-xs text-text-muted">
            Grouped by how much is traded each day (median of the last 60 sessions): Large is the
            300 most traded, Mid and Small are smaller. Penny and barely traded stocks are left out.
          </p>
        </div>
      ) : m.masked ? null : (
        <p className="m-0 text-sm text-text-muted">
          Size groups need 60 sessions of price history. Until then all sizes are listed together,
          and the rises and falls show only companies of at least one dollar a share with a million
          dollars traded that day.
        </p>
      )}
    </>
  );
}

const NO_DATA = (
  <EmptyState motif="market" hue="market" title="No market data yet">
    Prices appear here after the first nightly data run. Nothing is shown until then.
  </EmptyState>
);

export function MoversSection({
  model,
  q,
  mode,
  starAction,
}: {
  model: Promise<MarketModel>;
  q: MarketQuery;
  mode: WatchMode;
  starAction: Star;
}) {
  const m = use(model);
  if (m.state === "empty") return NO_DATA;
  const lists = [
    ["up", "Biggest rises", m.up, "No company rose at the last close.", "upPage"],
    ["down", "Biggest falls", m.down, "No company fell at the last close.", "downPage"],
    ["traded", "Most traded", m.traded, "No trading was recorded at the last close.", "tradedPage"],
  ] as const;
  // D-884: one list at a time behind a switch, so the falls are not buried below the rises
  const shown = lists.filter(([id]) => id === q.movers);
  return (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Which movers"
        value={q.movers}
        items={lists.map(([id, title]) => ({
          value: id,
          label: title,
          href: marketHref(q, { movers: id }),
        }))}
      />
      {shown.map(([, title, list, empty, key]) => (
        <div key={title} className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 text-base font-semibold">{title}</h3>
          <MarketTable
            caption={title}
            rows={list.rows}
            masked={m.masked}
            day={m.d}
            mode={mode}
            starAction={starAction}
            showVolume={false}
            empty={empty}
          />
          <Pager
            label={`${title} pages`}
            list={list}
            hrefFor={(page) => marketHref(q, { [key]: page })}
          />
        </div>
      ))}
    </div>
  );
}

export function SectorsSection({ model, q }: { model: Promise<MarketModel>; q: MarketQuery }) {
  const m = use(model);
  if (m.state === "empty") return NO_DATA;
  if (m.masked) {
    return (
      <EmptyState motif="market" hue="market" title="Sectors are hidden">
        Sector groups would reveal which companies are behind the letters, so they are hidden for
        your access level.
      </EmptyState>
    );
  }
  if (m.sectors.length === 0) {
    return (
      <EmptyState motif="market" hue="market" title="No sector data yet">
        Sectors appear once the company list carries an industry group for each company.
      </EmptyState>
    );
  }
  const all: MarketSection[] = q.open.includes("all") ? q.open : [...q.open, "all"];
  return (
    <>
      <SectorHeatGrid
        label="Average day change by sector"
        cells={m.sectors.map((s) => ({
          label: s.sector,
          value: ppmToPercent(s.avgChangePpm),
          hue: sectorKey(s.sector) === null ? null : `sector-${sectorKey(s.sector)}`,
        }))}
      />
      <Chips
        label="Open a sector"
        items={m.sectors.map((s) => ({
          href: marketHref(q, { open: all, sector: s.sector, page: 1 }),
          label: `${s.sector} (${s.count})`,
        }))}
      />
    </>
  );
}

export function CompaniesSection({
  model,
  q,
  mode,
  starAction,
}: {
  model: Promise<MarketModel>;
  q: MarketQuery;
  mode: WatchMode;
  starAction: Star;
}) {
  const m = use(model);
  if (m.state === "empty") return NO_DATA;
  return (
    <>
      {q.sector ? (
        <p className="m-0 text-sm">
          Sector: {q.sector}.{" "}
          <Link
            href={marketHref(q, { sector: undefined, page: 1 })}
            className="text-accent underline"
          >
            Show all sectors
          </Link>
        </p>
      ) : null}
      <MarketTable
        caption="All companies"
        rows={m.all.rows}
        masked={m.masked}
        day={m.d}
        mode={mode}
        starAction={starAction}
        empty="No companies match."
      />
      <Pager label="Pages" list={m.all} hrefFor={(page) => marketHref(q, { page })} />
    </>
  );
}
