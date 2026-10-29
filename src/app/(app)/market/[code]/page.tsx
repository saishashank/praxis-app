// Company page (UXN-271; ch.16 16.24): header, candle chart with volume, key numbers, our activity and
// the company's announcements. Stored end-of-day data only (UXN-273). Decision 21 of docs/M7_design.md:
// the Owner (and anyone with a live unmask grant) sees candles, exact prices and "Our activity"; a masked
// user sees derived numbers only (day change, 52-week position, volume against usual, moving-average
// relation) and headlines, as "Stock A", with no chart, price, link or activity. The route key is the
// code for unmasked users and an opaque slug for masked users; a real code from a masked user is the
// same 404 as an unknown one.
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { Banner, EmptyState } from "@/components/ui/States";
import { Breadcrumb } from "@/components/ui/Nav";
import { BAND_BG, hueStyle } from "@/components/ui/hue";
import { Masked } from "@/components/ui/Values";
import { loadCompany } from "@/lib/ui/loaders/company";
import { envFor } from "@/lib/ui/loaders/shell";
import { formatCount, formatDate, formatMicro } from "@/lib/view/format";
import { toggleWatchlistAction } from "../actions";
import { CompanyChart } from "../CompanyChart";
import { Change, Dash, FIG, Tile } from "../Figures";
import { RowActions, watchModeOf } from "../RowActions";
import { sectorHueOf } from "../sectorHue";
import {
  maText,
  MASKED_MARKET_NOTE,
  NOT_AVAILABLE,
  PRICE_LABEL,
  PRICE_NOTE,
  rangePositionText,
  volumeVsUsual,
} from "../text";

export const dynamic = "force-dynamic";

const PROFILE_LABEL: Record<string, string> = {
  aggressive: "Aggressive",
  balanced: "Balanced",
  conservative: "Conservative",
};
const PICK_STATE: Record<string, string> = { waiting: "Waiting to buy", bought: "Bought" };

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 justify-between gap-3 border-b border-border py-1">
      <dt className="text-text-muted">{term}</dt>
      <dd className={`${FIG} m-0 min-w-0 break-words text-right`}>{children}</dd>
    </div>
  );
}

export default async function CompanyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const user = await requireUser("read", "/market/[code]");
  let key = "";
  try {
    key = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  const env = await envFor(user);
  const c = await loadCompany(env, key);
  if (c === null) notFound();
  const mode = watchModeOf(user.role, c.masked);
  const title = c.name ?? c.stock;
  const hue = c.masked ? null : sectorHueOf(c.sector);

  return (
    <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 py-6">
      <Breadcrumb
        items={[{ href: "/market", label: "Market" }, { label: title }]}
        backHref="/market"
      />
      <header
        data-testid="company-header"
        data-sector-hue={hue ?? "none"}
        style={{ ...hueStyle(hue ?? "outcome-flat"), background: BAND_BG }}
        className="sticky top-14 z-30 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-l-4 border-border border-l-[var(--h-fill)] p-3"
      >
        <div className="min-w-0">
          <h1 className="m-0 text-2xl font-semibold tracking-tight break-words">{title}</h1>
          <p className="m-0 text-sm text-text-muted break-words">
            {c.name ? <span className={FIG}>{c.stock}</span> : null}
            {c.sector ? " · " + c.sector : ""}
            {c.sizeGroup ? ` · ${c.sizeGroup} company` : c.name ? " · Size not known yet" : ""}
          </p>
          {c.state === "empty" ? null : (
            <>
              <div className="mt-1 flex flex-wrap items-baseline gap-3">
                {c.closeMicro ? (
                  <span className={`${FIG} text-2xl font-semibold`}>
                    {formatMicro(c.closeMicro)}
                  </span>
                ) : (
                  <Masked />
                )}
                <Change ppm={c.changePpm} />
              </div>
              <p className="m-0 mt-1 text-sm text-text-muted">
                {PRICE_LABEL}
                {c.d ? `, ${formatDate(c.d)}` : ""}. {PRICE_NOTE}
              </p>
            </>
          )}
        </div>
        <RowActions
          slug={c.slug}
          stock={c.stock}
          starred={c.starred}
          mode={mode}
          starAction={toggleWatchlistAction}
        />
      </header>

      {c.masked ? (
        <Banner tone="info" title="Some details are hidden">
          {MASKED_MARKET_NOTE}
        </Banner>
      ) : null}
      {c.delisted ? (
        <Banner tone="warning" title="No longer listed">
          Delisted on {c.delisted.on}
          {c.delisted.reason ? `: ${c.delisted.reason}` : "."}
        </Banner>
      ) : null}
      {c.state === "stale" && c.staleText ? (
        <Banner tone="warning" title="Out of date">
          {c.staleText}
        </Banner>
      ) : null}

      {c.state === "empty" ? (
        <EmptyState title="No prices stored yet">
          This company has no stored prices. They appear after a nightly data run.
        </EmptyState>
      ) : null}

      {c.masked ? null : c.bars.length > 0 ? (
        <section aria-labelledby="chart-h" className="order-2 min-w-0">
          <h2 id="chart-h" className="m-0 mb-2 text-lg font-semibold">
            Price chart
          </h2>
          <CompanyChart bars={c.bars} markers={c.markers} label={title} hue={hue} />
        </section>
      ) : null}

      <section aria-labelledby="key-h" className="order-1 min-w-0 sm:order-3">
        <h2 id="key-h" className="m-0 mb-2 text-lg font-semibold">
          Key numbers
        </h2>
        <dl className="m-0 mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="52-week range">
            {c.rangeLowMicro && c.rangeHighMicro ? (
              `${formatMicro(c.rangeLowMicro)} to ${formatMicro(c.rangeHighMicro)}`
            ) : c.masked ? (
              <Dash hint="Hidden for your role" />
            ) : (
              <Dash />
            )}
          </Tile>
          <Tile label="Volume today">{formatCount(c.volume)}</Tile>
          <Tile label="Average daily volume">{formatCount(c.usualVolume)}</Tile>
          <Tile label="Volume against usual">{volumeVsUsual(c.volumeVsUsualPpm)}</Tile>
          <Tile label="Against 50-day average">{maText(c.ma.short)}</Tile>
          <Tile label="Against 200-day average">{maText(c.ma.long)}</Tile>
        </dl>
        <dl className="m-0 grid gap-x-6 sm:grid-cols-2">
          <Row term="Today within the range">{rangePositionText(c.rangePositionPpm)}</Row>
          {c.masked ? null : (
            <>
              <Row term="Market cap">{NOT_AVAILABLE}</Row>
              <Row term="P/E ratio">{NOT_AVAILABLE}</Row>
              <Row term="Dividend yield">{NOT_AVAILABLE}</Row>
              <Row term="Sector">{c.sector ?? NOT_AVAILABLE}</Row>
              <Row term="Listed since">{c.listedOn ? formatDate(c.listedOn) : NOT_AVAILABLE}</Row>
            </>
          )}
        </dl>
      </section>

      {c.activity ? (
        <section aria-labelledby="activity-h" className="order-4 min-w-0">
          <h2 id="activity-h" className="m-0 mb-2 text-lg font-semibold">
            Our activity
          </h2>
          <p className="m-0 mb-2 text-sm text-text-muted">
            Practice strategies only. Simulated: nothing here is a real order.
          </p>
          {c.activity.holders.length + c.activity.picks.length + c.activity.ideas.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">
              No practice strategy holds this company, and it has no open pick or trade idea.
            </p>
          ) : (
            <ul className="m-0 list-none space-y-1 p-0 text-sm">
              {c.activity.holders.map((h) => (
                <li key={h.execution}>
                  Held by{" "}
                  <Link
                    href={`/strategies/${encodeURIComponent(h.execution)}`}
                    className="underline"
                  >
                    {h.name}
                  </Link>
                </li>
              ))}
              {c.activity.picks.map((p) => (
                <li key={`${p.d}-${p.profile}`}>
                  <Link href="/picks" className="underline">
                    Pick
                  </Link>
                  : {PROFILE_LABEL[p.profile] ?? p.profile}, {formatDate(p.d)} (
                  {PICK_STATE[p.state] ?? p.state})
                </li>
              ))}
              {c.activity.ideas.map((i) => (
                <li key={i.family}>
                  <Link href="/strategies/ideas" className="underline">
                    Tonight&apos;s trade idea
                  </Link>
                  : {i.name}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section aria-labelledby="news-h" className="order-4 min-w-0">
        <h2 id="news-h" className="m-0 mb-2 text-lg font-semibold">
          News and announcements
        </h2>
        {c.announcements.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">
            No announcements have been stored for this company.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {c.announcements.map((a) => (
              <li
                key={a.id}
                className="min-w-0 break-words rounded-lg border border-border bg-surface p-2"
              >
                {a.url ? (
                  <a href={a.url} rel="noopener noreferrer" target="_blank" className="underline">
                    {a.title}
                  </a>
                ) : (
                  a.title
                )}
                {a.priceSensitive ? (
                  <span className="ml-2 text-xs text-text-muted">Could move the price</span>
                ) : null}
                <span className="block text-xs text-text-muted">{a.published}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
