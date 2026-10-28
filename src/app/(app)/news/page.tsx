// News and alert inbox (UX-060..062; UXN-035, UXN-038, UXN-157, UXN-158, UXN-160, UXN-161; D-136 draft).
// One tab, three chips: "All news" (the default), "My companies", "Alerts". The Alerts chip and the header bell open
// the same inbox: P0 always open at the top, P1 and P2 in collapsible sections with unread counts, and
// an "Archived" section for acknowledged alerts. Everything is read through the loaders, which mask for
// Editors and Viewers without a grant ("Stock A", no names, links or exact dates, DAT-124). Ack and
// snooze call the existing /api/alerts routes (D-101). `?item=<ann_id>` opens the news pop-up
// (Decision Card links, unmasked viewers only). Nothing here places an order.
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { AlertTierBadge } from "@/components/ui/Badges";
import { InfoButton } from "@/components/ui/Overlays";
import { Banner, EmptyState } from "@/components/ui/States";
import { neverSuppressed } from "@/lib/alerts/tiers";
import { requireUser } from "@/lib/auth/guard";
import { loadAlerts, parseAlertsQuery, type AlertsModel } from "@/lib/ui/loaders/alerts";
import {
  loadNews,
  loadNewsItem,
  parseNewsQuery,
  resolveNewsItemRef,
  type NewsItemRow,
} from "@/lib/ui/loaders/news";
import { envFor, loadShell } from "@/lib/ui/loaders/shell";
import { melbourneDate } from "@/lib/view/active";
import { isoWeek } from "@/lib/view/format";
import { NOT_ADVICE_FOOTER } from "@/lib/view/honesty";
import { AlertActions } from "./AlertActions";
import { NewsAutoSheet, NewsItemButton } from "./NewsSheet";
import {
  HELD_TAG,
  materialityLabel,
  POLARITY_HOW,
  polarityLabel,
  shortText,
  whenText,
} from "./text";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;
type AlertRow = AlertsModel["groups"][number]["alerts"][number];

// Owner 2026-10-27: All news first and the default
const CHIP_LABEL = { all: "All news", mine: "My companies", alerts: "Alerts" } as const;
const TIER_TITLE = { P0: "Urgent (P0)", P1: "Important (P1)", P2: "For information (P2)" } as const;

function href(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, v);
  const s = q.toString();
  return s ? `/news?${s}` : "/news";
}

const alertWhen = (a: AlertRow, masked: boolean): string => {
  if (!masked) return whenText(a.detectedAt);
  const d = melbourneDate(a.detectedAt);
  return d === null ? "n/a" : `Week ${isoWeek(d) ?? "n/a"}`;
};

function PolarityTag({ row }: { row: Pick<NewsItemRow, "polarity" | "materiality"> }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid="polarity-tag">
      <span className="rounded-md bg-surface-2 px-2 py-1 font-medium">
        {polarityLabel(row.polarity)}
      </span>
      <InfoButton label="How this tag was decided">
        <p className="m-0 text-sm">{POLARITY_HOW}</p>
      </InfoButton>
    </span>
  );
}

function AlertItem({ a, masked, nowMs }: { a: AlertRow; masked: boolean; nowMs: number }) {
  const acked = a.ackedAt !== null;
  const snoozed = a.snoozedUntil !== null && Date.parse(a.snoozedUntil) > nowMs;
  const snoozable = !neverSuppressed(a.tier, a.kind);
  const label = a.text.length > 60 ? `${a.text.slice(0, 57)}…` : a.text;
  return (
    <li
      className={`min-w-0 break-words rounded-lg border border-border bg-surface p-3 ${snoozed ? "opacity-70" : ""}`}
      data-testid="alert-item"
      data-snoozed={snoozed ? "1" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <AlertTierBadge tier={a.tier} />
        {a.code ? <span className="font-medium text-text">{a.code}</span> : null}
        <span>{alertWhen(a, masked)}</span>
        {acked ? <span>Acknowledged</span> : null}
        {snoozed ? <span>Snoozed (still listed)</span> : null}
      </div>
      <p className="mt-1 mb-0 text-sm font-medium">{a.text}</p>
      {a.why ? <p className="mt-1 mb-0 text-sm text-text-muted">{a.why}</p> : null}
      {a.executions.length > 0 ? (
        <p className="mt-1 mb-0 text-xs text-text-muted" data-testid="held-by">
          Held by: {a.executions.map((e) => e.label).join(", ")}
        </p>
      ) : null}
      <AlertActions
        alertKey={a.key}
        label={label}
        acked={acked}
        snoozable={snoozable}
        snoozed={snoozed}
      />
    </li>
  );
}

function AlertList({
  alerts,
  masked,
  nowMs,
}: {
  alerts: AlertRow[];
  masked: boolean;
  nowMs: number;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {alerts.map((a) => (
        <AlertItem key={a.key} a={a} masked={masked} nowMs={nowMs} />
      ))}
    </ul>
  );
}

function Inbox({ model, q, nowMs }: { model: AlertsModel; q: string | undefined; nowMs: number }) {
  const needle = q?.toLowerCase();
  const all = model.groups
    .flatMap((g) => g.alerts)
    .filter(
      (a) =>
        needle === undefined ||
        a.text.toLowerCase().includes(needle) ||
        a.why.toLowerCase().includes(needle),
    );
  const open = all.filter((a) => a.ackedAt === null);
  const archived = all.filter((a) => a.ackedAt !== null);
  const tiers = ["P0", "P1", "P2"] as const;
  return (
    <div className="flex flex-col gap-4" data-testid="alert-inbox">
      <p className="m-0 text-sm text-text-muted">
        {model.quietHours
          ? `Quiet hours: ${model.quietHours.start} to ${model.quietHours.end} Melbourne time. They quieten P1 and P2 only; urgent (P0) alerts and market-mood alerts are never silenced.`
          : "No quiet hours set. Urgent (P0) alerts and market-mood alerts are never silenced."}{" "}
        <Link href="/settings" className="text-accent underline">
          Settings
        </Link>
      </p>
      {tiers.map((tier) => {
        const rows = open.filter((a) => a.tier === tier);
        if (tier === "P0") {
          return (
            <section key={tier} aria-labelledby="tier-P0" className="flex flex-col gap-2">
              <h2 id="tier-P0" className="m-0 text-lg font-semibold">
                {TIER_TITLE.P0} <span className="text-sm font-normal">({rows.length} unread)</span>
              </h2>
              {rows.length === 0 ? (
                <p className="m-0 text-sm text-text-muted" data-testid="p0-empty">
                  No urgent alerts need you.
                </p>
              ) : (
                <AlertList alerts={rows} masked={model.masked} nowMs={nowMs} />
              )}
            </section>
          );
        }
        if (rows.length === 0) return null;
        return (
          <details key={tier} open className="flex flex-col gap-2" data-testid={`tier-${tier}`}>
            <summary className="cursor-pointer text-lg font-semibold">
              {TIER_TITLE[tier]} <span className="text-sm font-normal">({rows.length} unread)</span>
            </summary>
            <div className="mt-2">
              <AlertList alerts={rows} masked={model.masked} nowMs={nowMs} />
            </div>
          </details>
        );
      })}
      <details data-testid="archived">
        <summary className="cursor-pointer text-lg font-semibold">
          Archived <span className="text-sm font-normal">({archived.length} acknowledged)</span>
        </summary>
        <div className="mt-2">
          {archived.length === 0 ? (
            <p className="m-0 text-sm text-text-muted">Nothing archived yet.</p>
          ) : (
            <AlertList alerts={archived} masked={model.masked} nowMs={nowMs} />
          )}
        </div>
      </details>
    </div>
  );
}

export default async function NewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const user = await requireUser("read", "/news");
  const env = await envFor(user);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const query = parseNewsQuery(params);
  const alertsQuery = parseAlertsQuery(params);
  if (query === null || alertsQuery === null) notFound();
  const masked = env.mask.masked;
  const chip = query.chip;

  const [news, alerts, shell] = await Promise.all([
    chip === "alerts" ? null : loadNews(env, query),
    chip === "alerts" ? loadAlerts(env, alertsQuery) : null,
    loadShell(env),
  ]);

  // `?item=<ann_id>`: unmasked viewers only (cards never link it for a masked viewer).
  const itemRef = typeof sp.item === "string" ? sp.item : undefined;
  let sheet = null;
  let itemMissing = false;
  if (itemRef !== undefined) {
    const id = await resolveNewsItemRef(env, itemRef);
    sheet = id === null ? null : await loadNewsItem(env, id);
    itemMissing = sheet === null;
  }
  const closeHref = href({
    chip: chip === "all" ? undefined : chip,
    q: query.q,
    code: query.code,
    from: query.from,
    to: query.to,
  });

  const chipHref = (c: keyof typeof CHIP_LABEL) => href({ chip: c === "all" ? undefined : c });
  const unread = shell.bell.count;
  const hasFilter = [query.q, query.code, query.from, query.to].some((v) => v !== undefined);

  return (
    <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">News</h1>
        <p className="m-0 text-sm text-text-muted">
          Exchange announcements about companies, and the alerts the system raised.{" "}
          {NOT_ADVICE_FOOTER}
        </p>
      </header>

      <nav aria-label="News view" className="flex flex-wrap gap-2">
        {(Object.keys(CHIP_LABEL) as Array<keyof typeof CHIP_LABEL>).map((c) => (
          <Link
            key={c}
            href={chipHref(c)}
            aria-current={c === chip ? "page" : undefined}
            className={`inline-flex min-h-6 items-center rounded-full border border-border px-3 py-2 text-sm ${c === chip ? "bg-accent text-accent-contrast" : "bg-surface text-text"}`}
          >
            {CHIP_LABEL[c]}
            {c === "alerts" && unread > 0 ? ` (${unread} unread)` : ""}
          </Link>
        ))}
      </nav>

      <details open={hasFilter} className="rounded-lg border border-border bg-surface p-3">
        <summary className="cursor-pointer text-sm font-medium">Filter and search</summary>
        <form method="get" action="/news" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          {chip !== "all" ? <input type="hidden" name="chip" value={chip} /> : null}
          {masked && chip !== "alerts" ? null : (
            <label className="flex flex-col gap-1">
              Search
              <input
                name="q"
                type="search"
                maxLength={60}
                defaultValue={query.q ?? ""}
                className="min-h-6 rounded-md border border-border bg-bg px-2 py-1 text-text"
              />
            </label>
          )}
          {chip === "alerts" ? (
            <>
              <label className="flex flex-col gap-1">
                Tier
                <select
                  name="tier"
                  defaultValue={alertsQuery.tier ?? ""}
                  className="min-h-6 rounded-md border border-border bg-bg px-2 py-1 text-text"
                >
                  <option value="">All tiers</option>
                  <option value="P0">P0</option>
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input
                  name="unacked"
                  type="checkbox"
                  value="1"
                  defaultChecked={alertsQuery.unacked}
                />
                Unread only
              </label>
            </>
          ) : (
            <>
              {masked ? null : (
                <label className="flex flex-col gap-1">
                  Company code
                  <input
                    name="code"
                    maxLength={8}
                    defaultValue={query.code ?? ""}
                    className="min-h-6 w-28 rounded-md border border-border bg-bg px-2 py-1 text-text"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1">
                From
                <input
                  name="from"
                  type="date"
                  defaultValue={query.from ?? ""}
                  className="min-h-6 rounded-md border border-border bg-bg px-2 py-1 text-text"
                />
              </label>
              <label className="flex flex-col gap-1">
                To
                <input
                  name="to"
                  type="date"
                  defaultValue={query.to ?? ""}
                  className="min-h-6 rounded-md border border-border bg-bg px-2 py-1 text-text"
                />
              </label>
            </>
          )}
          <Button type="submit">Apply</Button>
          <Link href={chipHref(chip)} className="text-accent underline">
            Clear
          </Link>
        </form>
        {masked && chip !== "alerts" ? (
          <p className="mt-2 mb-0 text-xs text-text-muted">
            Search and company filters are not available for your access level.
          </p>
        ) : null}
      </details>

      {itemMissing ? (
        <Banner tone="warning" title="News item not found">
          That news item is not available.
        </Banner>
      ) : null}

      {chip === "alerts" && alerts ? (
        alerts.state === "empty" && alertsQuery.tier === undefined && !alertsQuery.unacked ? (
          <>
            <EmptyState title="No alerts">
              Nothing has been raised in the last two weeks. Urgent alerts will appear here first.
            </EmptyState>
          </>
        ) : (
          <Inbox model={alerts} q={query.q} nowMs={env.now.getTime()} />
        )
      ) : null}

      {news ? (
        <>
          {news.note ? <Banner tone="info">{news.note}</Banner> : null}
          {news.state === "empty" ? (
            <EmptyState title="No news yet">
              {hasFilter
                ? "Nothing matches these filters."
                : chip === "mine"
                  ? "No announcements about companies we hold or watch yet. Try All news."
                  : "No announcements have been stored yet. They appear once the news feed is switched on."}
            </EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="News">
              {news.items.map((n) => (
                <li key={n.id}>
                  <Card className="flex flex-col gap-2 p-3" data-testid="news-card">
                    {/* Owner 2026-10-27: the headline first, then a short text, then who and when */}
                    <p className="m-0 text-base font-semibold leading-snug">
                      <NewsItemButton id={n.id} headline={n.title} />
                    </p>
                    {shortText(n) ? (
                      <p
                        className="m-0 line-clamp-3 text-sm text-text-muted"
                        data-testid="news-short"
                      >
                        {shortText(n)}
                      </p>
                    ) : null}
                    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                      <span className="font-medium text-text">
                        {n.company ? `${n.company} (${n.stock})` : n.stock}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{whenText(n.published)}</span>
                      {n.priceSensitive ? (
                        <span className="rounded-md bg-surface-2 px-2 py-0.5 font-medium text-text">
                          Price-sensitive
                        </span>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      {n.materiality !== null ? (
                        <span className="text-xs text-text-muted">
                          {materialityLabel(n.materiality)}
                        </span>
                      ) : null}
                      {/* D-200: an unassessed item shows no tag rather than "Not assessed yet" on every card */}
                      {n.polarity !== null ? <PolarityTag row={n} /> : null}
                      {n.heldByUs ? (
                        <span className="text-xs font-medium" data-testid="held-tag">
                          {HELD_TAG}
                        </span>
                      ) : null}
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          {news.page > 1 || news.hasMore ? (
            <nav aria-label="Pages" className="flex gap-4 text-sm">
              {news.page > 1 ? (
                <Link
                  className="text-accent underline"
                  href={href({
                    chip: chip === "all" ? undefined : chip,
                    q: query.q,
                    code: query.code,
                    from: query.from,
                    to: query.to,
                    page: String(news.page - 1),
                  })}
                >
                  Newer
                </Link>
              ) : null}
              {news.hasMore ? (
                <Link
                  className="text-accent underline"
                  href={href({
                    chip: chip === "all" ? undefined : chip,
                    q: query.q,
                    code: query.code,
                    from: query.from,
                    to: query.to,
                    page: String(news.page + 1),
                  })}
                >
                  Older
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : null}

      {sheet ? (
        <NewsAutoSheet
          closeHref={closeHref}
          item={{
            id: sheet.id,
            stock: sheet.stock,
            company: sheet.company,
            title: sheet.title,
            type: sheet.type,
            published: sheet.published,
            priceSensitive: sheet.priceSensitive,
            materiality: sheet.materiality,
            polarity: sheet.polarity,
            assessment: sheet.assessment,
            url: sheet.url,
          }}
        />
      ) : null}
    </main>
  );
}
