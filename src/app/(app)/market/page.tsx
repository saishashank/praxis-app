// Market (UXN-270, UXN-273; ch.16 16.24; D-205): search, the main index and three sections (Top movers,
// Sectors, All companies). Read-only for every signed-in role; end-of-day data from the nightly tables
// only (no source call per page view). A masked user (Editor/Viewer without an unmask grant) sees
// "Stock A" with derived numbers and no names, codes or prices, and search is switched off for them
// (DAT-124, D-129, D-136).
// D-205 (Owner 2026-10-29): the page answers at once. Its data loads start here without waiting; each
// part reads its promise inside its own Suspense boundary and shows a spinner until it is ready. Only
// Top movers is open by default; a closed section starts no load. The checks that can answer 404 run
// before anything is sent.
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { requireUser } from "@/lib/auth/guard";
import { Banner } from "@/components/ui/States";
import { loadIndexStrip } from "@/lib/ui/loaders/company";
import {
  loadMarket,
  MASKED_NOTE,
  parseMarketQuery,
  parseSearchQuery,
  searchInstruments,
} from "@/lib/ui/loaders/market";
import { envFor } from "@/lib/ui/loaders/shell";
import { toggleWatchlistAction } from "./actions";
import { MarketSearch } from "./MarketSearch";
import { watchModeOf } from "./RowActions";
import {
  CompaniesSection,
  IndexSection,
  MarketSectionFrame,
  MarketStatus,
  MoversSection,
  SectionLoading,
  SectorsSection,
} from "./sections";
import { MASKED_MARKET_NOTE, PRICE_NOTE } from "./text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

export default async function MarketPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/market");
  const env = await envFor(user);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const q = parseMarketQuery(params);
  if (q === null) notFound();
  const term = parseSearchQuery(params);
  const search = term ? await searchInstruments(env, term) : null;
  const masked = env.mask.masked;
  const mode = watchModeOf(user.role, masked);
  // started, not awaited: the sections below wait for them on their own
  const model = loadMarket(env, q);
  const index = loadIndexStrip(env);

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Market</h1>
        <p className="m-0 text-sm text-text-muted">{PRICE_NOTE}</p>
      </header>

      {masked ? (
        <Banner tone="info" title="Some details are hidden">
          {MASKED_MARKET_NOTE}
        </Banner>
      ) : null}

      <MarketSearch
        initialQuery={search?.q ?? ""}
        initialHits={search?.results ?? []}
        masked={masked}
        note={masked ? MASKED_NOTE : null}
        mode={mode}
        starAction={toggleWatchlistAction}
      />

      <section aria-labelledby="index-h" className="rounded-lg border border-border bg-surface p-3">
        <h2 id="index-h" className="m-0 text-lg font-semibold">
          Main index
        </h2>
        <Suspense fallback={<SectionLoading label="Loading the main index" />}>
          <IndexSection index={index} masked={masked} />
        </Suspense>
      </section>

      <Suspense fallback={<SectionLoading label="Loading the latest prices" />}>
        <MarketStatus model={model} q={q} />
      </Suspense>

      <MarketSectionFrame id="movers" title="Top movers" q={q}>
        <Suspense fallback={<SectionLoading label="Loading the top movers" />}>
          <MoversSection model={model} q={q} mode={mode} starAction={toggleWatchlistAction} />
        </Suspense>
      </MarketSectionFrame>

      <MarketSectionFrame id="sectors" title="Sectors" q={q}>
        <Suspense fallback={<SectionLoading label="Loading the sectors" />}>
          <SectorsSection model={model} q={q} />
        </Suspense>
      </MarketSectionFrame>

      <MarketSectionFrame id="all" title="All companies" q={q}>
        <Suspense fallback={<SectionLoading label="Loading all companies" />}>
          <CompaniesSection model={model} q={q} mode={mode} starAction={toggleWatchlistAction} />
        </Suspense>
      </MarketSectionFrame>
    </main>
  );
}
