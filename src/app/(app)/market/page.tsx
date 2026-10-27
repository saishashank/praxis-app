// Market (UXN-270, UXN-273; ch.16 16.24): search, the main index, top movers, sectors and all companies.
// Read-only for every signed-in role; end-of-day data from the nightly tables only (no source call per
// page view). A masked user (Editor/Viewer without an unmask grant) sees "Stock A" with derived numbers
// and no names, codes or prices, and search is switched off for them (DAT-124, D-129, D-136).
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { Sparkline } from "@/components/charts/Sparkline";
import { HeatGrid } from "@/components/charts/Grids";
import { Banner, EmptyState } from "@/components/ui/States";
import { Chips, Tabs } from "@/components/ui/Nav";
import { GainLoss } from "@/components/ui/Values";
import { loadIndexStrip } from "@/lib/ui/loaders/company";
import {
  loadMarket,
  parseMarketQuery,
  parseSearchQuery,
  searchInstruments,
} from "@/lib/ui/loaders/market";
import { envFor } from "@/lib/ui/loaders/shell";
import { toggleWatchlistAction } from "./actions";
import { MarketSearch } from "./MarketSearch";
import { MarketTable } from "./MarketTable";
import { watchModeOf } from "./RowActions";
import { MASKED_MARKET_NOTE, PRICE_NOTE, ppmToPercent } from "./text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

const href = (tab: string, extra: Record<string, string | number | undefined> = {}): string => {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) q.set(k, String(v));
  return `/market?${q.toString()}`;
};

export default async function MarketPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/market");
  const env = await envFor(user);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const query = parseMarketQuery(params);
  if (query === null) notFound();
  const [model, index] = await Promise.all([loadMarket(env, query), loadIndexStrip(env)]);
  const term = parseSearchQuery(params);
  const search = term ? await searchInstruments(env, term) : null;
  const mode = watchModeOf(user.role, model.masked);

  // D-193: one size group at a time (Large by default), kept across the views
  const sizes = [
    { id: "large", label: "Large" },
    { id: "mid", label: "Mid" },
    { id: "small", label: "Small" },
  ] as const;
  const withSize = (tab: string, extra: Record<string, string | number | undefined> = {}) =>
    href(tab, model.size === "large" ? extra : { ...extra, size: model.size });

  const tabs = [
    { id: "movers", label: "Top movers" },
    { id: "sectors", label: "Sectors" },
    { id: "all", label: "All companies" },
  ] as const;
  const last = Math.max(1, Math.ceil(model.page.total / model.page.size));

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Market</h1>
        <p className="m-0 text-sm text-text-muted">
          {PRICE_NOTE}
          {model.d ? ` Latest data: ${model.d}.` : ""}
        </p>
      </header>

      {model.masked ? (
        <Banner tone="info" title="Some details are hidden">
          {MASKED_MARKET_NOTE}
        </Banner>
      ) : null}
      {model.state === "stale" && model.staleText ? (
        <Banner tone="warning" title="Out of date">
          {model.staleText}
        </Banner>
      ) : null}

      <MarketSearch
        initialQuery={search?.q ?? ""}
        initialHits={search?.results ?? []}
        masked={model.masked}
        note={model.masked ? model.note : null}
        mode={mode}
        starAction={toggleWatchlistAction}
      />

      <section aria-labelledby="index-h" className="rounded-lg border border-border bg-surface p-3">
        <h2 id="index-h" className="m-0 text-lg font-semibold">
          Main index
        </h2>
        {index ? (
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span>
              {model.masked ? "Market index" : index.code}, close of {index.d}
            </span>
            <GainLoss value={index.changePpm} kind="ppm" />
            <Sparkline values={index.closes} label="Main index, last month" />
          </div>
        ) : (
          <p className="m-0 mt-1 text-sm text-text-muted">
            No index data has been stored yet. It appears after a nightly run.
          </p>
        )}
      </section>

      {model.sized ? (
        <div className="flex flex-col gap-1">
          <Tabs
            label="Company size"
            items={sizes.map((z) => ({
              href: href(model.tab, z.id === "large" ? {} : { size: z.id }),
              label: z.label,
              current: z.id === model.size,
            }))}
          />
          <p className="m-0 text-xs text-text-muted">
            Grouped by how much is traded each day (median of the last 60 sessions): Large is the
            300 most traded, Mid and Small are smaller. Penny and barely traded stocks are left out.
          </p>
        </div>
      ) : (
        <p className="m-0 text-sm text-text-muted">
          Size groups need 60 sessions of price history. Until then all sizes are listed together,
          without penny and barely traded stocks.
        </p>
      )}

      <Tabs
        label="Market views"
        items={tabs.map((t) => ({
          href: withSize(t.id),
          label: t.label,
          current: t.id === model.tab,
        }))}
      />

      {model.state === "empty" ? (
        <EmptyState title="No market data yet">
          Prices appear here after the first nightly data run. Nothing is shown until then.
        </EmptyState>
      ) : model.tab === "movers" ? (
        <div className="flex flex-col gap-6">
          {(
            [
              ["Biggest rises", model.up, "No company rose at the last close."],
              ["Biggest falls", model.down, "No company fell at the last close."],
              ["Most traded", model.traded, "No trading was recorded at the last close."],
            ] as const
          ).map(([title, rows, empty]) => (
            // D-193: each list folds away, so the page needs less scrolling
            <details
              key={title}
              open
              aria-label={title}
              className="group/fold flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
            >
              <summary className="cursor-pointer list-none">
                <h2 className="m-0 inline text-lg font-semibold">
                  <span aria-hidden="true" className="mr-2 inline-block group-open/fold:rotate-90">
                    ›
                  </span>
                  {title}
                </h2>
              </summary>
              <MarketTable
                caption={title}
                rows={rows}
                masked={model.masked}
                mode={mode}
                starAction={toggleWatchlistAction}
                showVolume={false}
                empty={empty}
              />
            </details>
          ))}
        </div>
      ) : model.tab === "sectors" ? (
        <section aria-label="Sectors" className="flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">Sectors</h2>
          {model.masked ? (
            <EmptyState title="Sectors are hidden">
              Sector groups would reveal which companies are behind the letters, so they are hidden
              for your access level.
            </EmptyState>
          ) : model.sectors.length === 0 ? (
            <EmptyState title="No sector data yet">
              Sectors appear once the company list carries an industry group for each company.
            </EmptyState>
          ) : (
            <>
              <HeatGrid
                label="Average day change by sector"
                cells={model.sectors.map((s) => ({
                  label: s.sector,
                  value: ppmToPercent(s.avgChangePpm),
                }))}
              />
              <Chips
                label="Open a sector"
                items={model.sectors.map((s) => ({
                  href: withSize("all", { sector: s.sector }),
                  label: `${s.sector} (${s.count})`,
                }))}
              />
            </>
          )}
        </section>
      ) : (
        <section aria-label="All companies" className="flex min-w-0 flex-col gap-2">
          <h2 className="m-0 text-lg font-semibold">All companies</h2>
          {query.sector ? (
            <p className="m-0 text-sm">
              Sector: {query.sector}.{" "}
              <Link href={withSize("all")} className="text-accent underline">
                Show all sectors
              </Link>
            </p>
          ) : null}
          <MarketTable
            caption="All companies"
            rows={model.rows}
            masked={model.masked}
            mode={mode}
            starAction={toggleWatchlistAction}
            empty="No companies match."
          />
          {model.page.total > model.page.size ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 text-sm">
              {model.page.number > 1 ? (
                <Link
                  href={withSize("all", { sector: query.sector, page: model.page.number - 1 })}
                  className="text-accent underline"
                >
                  Previous page
                </Link>
              ) : (
                <span />
              )}
              <span>
                Page {model.page.number} of {last}
              </span>
              {model.page.number < last ? (
                <Link
                  href={withSize("all", { sector: query.sector, page: model.page.number + 1 })}
                  className="text-accent underline"
                >
                  Next page
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </section>
      )}
    </main>
  );
}
