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
import { ppmToPercent } from "./text";

type Star = (fd: FormData) => Promise<WatchResult>;

/** The spinner a section shows while its data loads. */
export function SectionLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-4 text-sm text-text-muted">
      <span
        aria-hidden="true"
        className="inline-block size-5 animate-spin rounded-full border-2 border-border border-t-accent"
      />
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
      <h2 id={`${id}-h`} className="m-0 text-lg font-semibold">
        <Link
          href={marketHref(q, { open: toggled })}
          aria-expanded={open}
          scroll={false}
          className="flex min-h-10 items-center gap-2"
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

export function IndexSection({ index, masked }: { index: Promise<IndexStrip>; masked: boolean }) {
  const strip = use(index);
  return strip ? (
    <div className="mt-1 flex flex-wrap items-center gap-3">
      <span>
        {masked ? "Market index" : strip.code}, close of {strip.d}
      </span>
      <Change ppm={strip.changePpm} />
      <Sparkline values={strip.closes} label="Main index, last month" />
    </div>
  ) : (
    <p className="m-0 mt-1 text-sm text-text-muted">
      No index data has been stored yet. It appears after a nightly run.
    </p>
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
      {m.d ? <p className="m-0 text-sm text-text-muted">Latest data: {m.d}.</p> : null}
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
    ["Biggest rises", m.up, "No company rose at the last close.", "upPage"],
    ["Biggest falls", m.down, "No company fell at the last close.", "downPage"],
    ["Most traded", m.traded, "No trading was recorded at the last close.", "tradedPage"],
  ] as const;
  return (
    <div className="flex flex-col gap-6">
      {lists.map(([title, list, empty, key]) => (
        <div key={title} className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 text-base font-semibold">{title}</h3>
          <MarketTable
            caption={title}
            rows={list.rows}
            masked={m.masked}
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
        mode={mode}
        starAction={starAction}
        empty="No companies match."
      />
      <Pager label="Pages" list={m.all} hrefFor={(page) => marketHref(q, { page })} />
    </>
  );
}
