// Home = "Today" (UX-010 to UX-017, UXN-034; V2 UXR-020, 044, 053, 055, 056). A pure server component over the
// masked Home view model: it prints exactly what the loader returns, so a masked viewer never gets a code,
// name, price or exact date. Money is always shown with the Simulated label (AT-27). Order: status strip
// (market-mood gradient), welcome, Since yesterday, Needs you, Today's picks, strategy tiles, then the
// secondary lists. States: empty (what will appear and when, UXR-007), stale (banner with the last good
// date), error (the loader failed; the rest of the shell still works).
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FamilyBadge, Rail } from "@/components/ui/Family";
import { ChevronRightIcon } from "@/components/ui/icons";
import { StatusStrip, type Mood } from "@/components/ui/StatusStrip";
import { Banner, EmptyState } from "@/components/ui/States";
import { hueStyle } from "@/components/ui/hue";
import { GainLoss, Masked, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDay, formatMicro, formatPpm, plural } from "@/lib/view/format";
import { regimeLabel } from "@/lib/view/terms";
import type { Loaded } from "@/lib/ui/loaders/common";
import type { HomeNeed, HomePick, HomeSinceRow, HomeView } from "@/lib/ui/loaders/home";
import { EmptyArt, Sparkline } from "./Art";
import { familyBadge } from "./familyMap";
import { CountUp, PopIn } from "./Motion";
import { WelcomeBanner } from "./WelcomeBanner";
import { IntradaySection } from "../picks/IntradaySection";
import { PortfolioCard } from "../picks/PortfolioCard";
import { ProfileLabel } from "../picks/ProfileLabel";
import { profileHue } from "../picks/text";

const SIZE_NAME: Record<string, string> = { U1: "Large", U2: "Mid", U3: "Small" };
const MAX_HOME_CARDS = 3; // threshold-ok: UXR-020 shows up to 3 pick cards

const linkCls = "text-accent underline";

/**
 * D-884 ("too much boxed information, use sliding tiles on mobile"): a row of small tiles that
 * slides sideways on a phone (snap to each tile) and becomes a grid from sm up.
 */
const tileStrip =
  "ui-scroll-x m-0 -mx-1 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-3";
const tileItem = "w-[78%] min-w-0 shrink-0 snap-start sm:w-auto";

/** One short meaning per market mood word (Owner 2026-11-10: one plain word and what it means). */
const MOOD_MEANING: Record<string, string> = {
  "RISK-ON": "prices are steady and trending up",
  NEUTRAL: "no clear direction",
  "RISK-OFF": "prices are swinging down",
  SHOCK: "a sudden, sharp market fall",
};

/** Market regime -> gradient key and the one plain word printed on it (the gradient is decoration, UXR-053). */
export function moodOf(regime: string | null): { key: Mood; word: string } {
  if (!regime) return { key: "neutral", word: "Not measured yet" };
  const shown = regimeLabel(regime).shown;
  const meaning = MOOD_MEANING[regime];
  const word = meaning ? `${shown}: ${meaning}` : shown;
  switch (regime) {
    case "RISK-ON":
      return { key: "on", word };
    case "RISK-OFF":
    case "SHOCK":
      return { key: "off", word };
    default:
      return { key: "neutral", word };
  }
}

/** "2026-11-09" -> "Mon 9 Nov"; text that is not an ISO day (an ISO week for a masked viewer) is kept. */
const dayText = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? formatDay(d) : d);

const outcomeHue = (v: number | null): "positive" | "negative" | "outcome-flat" =>
  v === null || v === 0 ? "outcome-flat" : v > 0 ? "positive" : "negative";

function Section({
  title,
  id,
  more,
  children,
  className,
}: {
  title: string;
  id: string;
  more?: { href: string; label: string };
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card title={title} aria-label={title} id={id} className={className}>
      {children}
      {more ? (
        <p className="mt-3 text-sm">
          <Link href={more.href} className={linkCls}>
            {more.label}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

/** UXR-007: an illustration in the section colour and one sentence on what will appear and when. */
function Empty({
  hue,
  shape,
  children,
}: {
  hue: string;
  shape: "picks" | "ideas" | "list" | "news" | "check";
  children: ReactNode;
}) {
  return (
    <div data-empty="" className="flex min-w-0 items-center gap-3">
      <EmptyArt hue={hue} shape={shape} />
      <p className="m-0 min-w-0 text-sm text-text-muted">{children}</p>
    </div>
  );
}

/** "tonight 18:10" -> "tonight's 18:10 run"; "Mon 18:10" -> "Mon's 18:10 run". */
function nextRunPhrase(nextRun: string): string {
  const m = /^(\S+) (\d{2}:\d{2})$/.exec(nextRun);
  return m ? `${m[1]}'s ${m[2]} run` : "next run";
}

/**
 * One actionable line about the day (UXN-034, Owner 2026-11-10): what is on the list or when the first
 * picks come, then how the strategies are doing today. Never names a stock.
 */
export function daySentence(v: HomeView): string {
  const parts: string[] = [];
  const n = v.picksTotal > 0 ? v.picksTotal : v.picks.items.length;
  if (n > 0) {
    parts.push(`${n} ${plural(n, "pick")} on the list for the next session.`);
  } else {
    parts.push(`No picks yet: the first ones come after ${nextRunPhrase(v.nextRun)}.`);
  }
  const ppm = v.headline[0]?.dayChangePpm ?? null;
  if (ppm !== null) {
    const when = v.dayLabel?.startsWith("Today (delayed")
      ? "today (delayed)"
      : v.dayLabel === "Today" || v.dayLabel === null
        ? "today"
        : `on ${v.dayLabel}`;
    parts.push(
      ppm === 0
        ? `Your strategies are unchanged ${when}.`
        : `Your strategies are ${ppm > 0 ? "up" : "down"} ${formatPpm(Math.abs(ppm))} ${when}.`,
    );
  }
  return parts.join(" ");
}

/** UXR-020 (1) + UXR-053: mood gradient, outcome-coloured number with a sparkline, freshness, next run. */
function Strip({ v, asOf }: { v: HomeView; asOf: string | null }) {
  const h = v.headline[0];
  const sinceHue = outcomeHue(h?.sinceStartPpm ?? null);
  const items: Array<{ label: string; value: ReactNode }> = [];
  if (h && h.sinceStartPpm !== null) {
    const pct = h.sinceStartPpm / 10_000; // threshold-ok: ppm -> percent
    const word = pct > 0 ? "gain" : pct < 0 ? "loss" : "no change";
    items.push({
      label: "Practice result since the start",
      value: (
        <span
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
          style={{ color: `var(--color-${sinceHue}-text)` }}
          data-outcome={sinceHue}
        >
          <span className="text-2xl leading-none font-semibold">
            <span aria-hidden="true">{pct > 0 ? "▲ " : pct < 0 ? "▼ " : "– "}</span>
            <CountUp
              value={pct}
              prefix={pct > 0 ? "+" : ""}
              suffix="%"
              label={`${word}: ${formatPpm(h.sinceStartPpm, { sign: "always" })} since the start`}
            />
          </span>
          <Sparkline values={h.series} hue={sinceHue} />
          {h.dayChangePpm !== null ? (
            <span className="text-xs font-normal text-text-muted">
              {v.dayLabel ?? "Today"} {formatPpm(h.dayChangePpm, { sign: "always" })}
            </span>
          ) : null}
        </span>
      ),
    });
  } else {
    items.push({ label: "Practice result since the start", value: <NotMeasured /> });
  }
  // D-907: the ASX 200 line, delayed during the session, the last close otherwise.
  const ix = v.day.index;
  if (ix) {
    const hue = outcomeHue(ix.changePpm);
    items.push({
      label: ix.name,
      value: (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>
            {ix.level.toLocaleString("en-AU", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })}
          </span>
          {ix.changePpm !== null ? (
            <span style={{ color: `var(--color-${hue}-text)` }} data-outcome={hue}>
              <span aria-hidden="true">
                {ix.changePpm > 0 ? "▲ " : ix.changePpm < 0 ? "▼ " : "– "}
              </span>
              {formatPpm(ix.changePpm, { sign: "always" })}
            </span>
          ) : null}
          <span className="text-xs font-normal text-text-muted">
            {ix.at ? `delayed, ${ix.at}` : ix.d ? `close ${formatDay(ix.d)}` : ""}
          </span>
        </span>
      ),
    });
  }
  items.push({
    label: "Prices",
    value: v.dataAtLabel ?? (asOf ? formatDay(asOf) : <NotMeasured>No run yet</NotMeasured>),
  });
  // D-884: no run times on Home ("don't give technical information like next run 18:30")
  if (v.dataOnly) {
    // UXR-006: the one place that says it; the shell header only shows the dot.
    items.push({
      label: "Mode",
      value: <span data-testid="data-only-line">Data only: prices and news, no trading yet</span>,
    });
  }
  return (
    <StatusStrip
      label="Today at a glance"
      items={items}
      mood={moodOf(v.day.regime)}
      className="min-w-0 break-words"
    />
  );
}

const SINCE_HUE: Record<HomeSinceRow["key"], string> = {
  pickhits: "tier-p1",
  candidates: "family-id",
  picks: "brand-a",
  ideas: "brand-b",
  fills: "status-running",
  alerts: "tier-p1",
  breakers: "tier-p0",
};

/** UXR-020 (2): rows, not boxes; each row is one link. */
function SinceYesterday({ rows }: { rows: HomeSinceRow[] }) {
  return (
    <Section id="home-since" title="Since yesterday">
      {rows.length === 0 ? (
        <Empty hue="brand-a" shape="list">
          Changes since the last session appear here after tonight&apos;s run.
        </Empty>
      ) : (
        <ul className="m-0 list-none divide-y divide-border p-0">
          {rows.map((r) => (
            <li key={r.key} className="min-w-0">
              <Link
                href={r.href}
                data-since={r.key}
                style={hueStyle(SINCE_HUE[r.key])}
                className="flex min-h-11 items-center gap-3 py-2 text-sm hover:underline"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full bg-[var(--h-fill)]"
                />
                <span className="min-w-0 flex-1 break-words">{r.text}</span>
                <ChevronRightIcon className="shrink-0 text-text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** UXR-020 (4): alert and queue items, tier-coloured, one action each. */
function NeedsYou({ needs }: { needs: HomeNeed[] }) {
  return (
    <Section id="home-needs" title="Needs you">
      {needs.length === 0 ? (
        <Empty hue="status-running" shape="check">
          Nothing needs you. Urgent and important alerts show here as soon as one arrives.
        </Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {needs.map((n) => (
            <li key={n.key} className="min-w-0" data-need={n.tier}>
              <Rail
                hue={`tier-${n.tier.toLowerCase()}`}
                header={
                  <span className="inline-flex items-center gap-2 text-sm font-semibold">
                    {n.tier === "P0" ? "Urgent" : n.tier === "P1" ? "Important" : "FYI"}
                  </span>
                }
              >
                <p className="m-0 text-sm break-words">{n.text}</p>
                <p className="m-0 mt-2">
                  <Link href={n.href} className={buttonClass("secondary")}>
                    {n.action}
                  </Link>
                </p>
              </Rail>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** UXR-020 (3) + UXR-052: family rail, tinted band, family badge; primary action "Why this pick". */
function PickCard({ p, masked }: { p: HomePick; masked: boolean }) {
  const fam = familyBadge(p.family);
  return (
    <Rail
      hue={profileHue(p.profile)}
      className="h-full"
      header={
        <span className="flex flex-wrap items-center justify-between gap-2">
          <PopIn>
            <FamilyBadge code={fam.code} label={fam.label} />
          </PopIn>
          <span className="text-xs">
            <ProfileLabel profile={p.profile} suffix={` #${p.rank}`} />
          </span>
        </span>
      }
    >
      <p className="m-0 min-w-0 break-words">
        <span className="font-semibold">{p.stock}</span>
        {SIZE_NAME[p.tier] ? (
          <span className="text-text-muted"> · {SIZE_NAME[p.tier]} company</span>
        ) : null}
      </p>
      {p.referenceMicro !== null ? (
        <p className="m-0 mt-1 text-sm">
          Aim {p.aimMicro !== null ? <Money micro={p.aimMicro} /> : "n/a"} · Stop{" "}
          {p.stopMicro !== null ? <Money micro={p.stopMicro} /> : "n/a"}
        </p>
      ) : masked ? (
        <p className="m-0 mt-1 text-sm">
          <Masked label="Prices hidden for your role" />
        </p>
      ) : null}
      <p className="m-0 mt-1 text-xs text-text-muted">
        {p.timeFrameSessions !== null
          ? `Time frame ${p.timeFrameSessions} ${plural(p.timeFrameSessions, "session")}`
          : "Time frame not set"}
        {p.validUntil ? ` · Valid until ${dayText(p.validUntil)}` : ""}
      </p>
      <p className="m-0 mt-3">
        <Link href={p.whyHref} className={buttonClass("default")}>
          Why this pick
        </Link>
      </p>
    </Rail>
  );
}

/** D-192: one tile per strategy, each with its own pretend money; nothing is added across them. */
function SummaryCard({ v }: { v: HomeView }) {
  const s = v.summary;
  return (
    <Card title="Strategies today" aria-label="Strategies today">
      {s.tiles.length === 0 ? (
        <Empty hue="brand-b" shape="list">
          <span>No strategy is running yet.</span>{" "}
          <span>The six strategies appear here with A$600 each after tonight&apos;s run.</span>
        </Empty>
      ) : (
        <ul className={tileStrip} aria-label="Strategies today">
          {s.tiles.map((t) => (
            <li
              key={`${t.id}-${t.startD}`}
              className={`${tileItem} relative rounded-lg border border-border bg-surface p-3 hover:border-accent focus-within:border-accent`}
              data-strategy-tile={t.id}
            >
              {/* D-200: the whole tile opens the strategy (the link covers the tile) */}
              <p className="m-0 truncate text-sm font-semibold">
                <Link
                  href={`/strategies/${t.id}`}
                  className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {t.name}
                </Link>
              </p>
              <p className="m-0 mt-1 text-xl font-semibold">
                <Money micro={t.value.micro} />
              </p>
              <p className="m-0 mt-1 text-xs text-text-muted">
                Started with <Money micro={t.seed.micro} /> on {formatDay(t.startD)}
              </p>
              <p className="m-0 mt-1 text-sm">
                <GainLoss value={t.sinceStart.micro}>
                  {`${formatMicro(t.sinceStart.micro, { sign: "always" })}${
                    t.sinceStartPpm !== null
                      ? ` (${formatPpm(t.sinceStartPpm, { sign: "always" })})`
                      : ""
                  }`}
                </GainLoss>{" "}
                <span className="text-text-muted">since the start</span>
              </p>
              {t.dayChange ? (
                <p className="m-0 mt-1 text-xs text-text-muted">
                  {v.dayLabel ?? "Today"}:{" "}
                  <GainLoss value={t.dayChange.micro}>
                    {`${formatMicro(t.dayChange.micro, { sign: "always" })}${
                      t.dayChangePpm !== null
                        ? ` (${formatPpm(t.dayChangePpm, { sign: "always" })})`
                        : ""
                    }`}
                  </GainLoss>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-text-muted">
        {s.d
          ? v.dayLabel?.startsWith("Today (delayed")
            ? "Values move with delayed prices during the session. "
            : `End of day, ${formatDay(s.d)}. `
          : ""}
        Each strategy invests its own pretend money, with no borrowing. The amounts are never added
        together.
      </p>
      <p className="mt-1">
        <SimulatedLabel />
      </p>
    </Card>
  );
}

export function HomeContent({
  result,
  role,
  showWelcome,
}: {
  /** null = the loader failed. */
  result: Loaded<HomeView> | null;
  role: string | null;
  showWelcome: boolean;
}) {
  if (!result) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Today</h1>
        {showWelcome ? <WelcomeBanner /> : null}
        <Banner tone="danger" title="Could not load Home">
          Something went wrong while reading today&apos;s numbers. Try again in a moment. The menus
          still work.
        </Banner>
      </>
    );
  }
  const v = result.data;
  const masked = result.masked;
  const empty = result.state === "empty";
  const canWatch = role === "owner" || role === "editor";
  // Up to 3 cards: the top pick of each profile, else the first three in list order.
  const top = v.picks.items.filter((p) => p.rank === 1);
  const cards = (top.length > 0 ? top : v.picks.items).slice(0, MAX_HOME_CARDS);
  const twoCol = "grid grid-cols-1 gap-4 lg:grid-cols-2";

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="mt-1 text-sm text-text-muted" data-summary="">
          {empty ? "Nothing has run yet." : daySentence(v)}
        </p>
        {v.top5Line ? (
          <p className="mt-1 text-sm text-text-muted" data-testid="top5-line">
            {v.top5Line}
          </p>
        ) : null}
      </div>

      <Strip v={v} asOf={result.asOf} />

      {showWelcome ? (
        <WelcomeBanner />
      ) : (
        <p className="m-0 text-sm" data-testid="how-it-works">
          New here?{" "}
          <Link href="/settings/about" className={linkCls}>
            Read how Praxis works
          </Link>
        </p>
      )}

      {result.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {result.text}
        </Banner>
      ) : null}

      {empty ? (
        <EmptyState motif="home" hue="home" title="No data yet">
          {result.text} The six strategies show A$600, Starting, once they exist. First trade ideas
          come after tonight&apos;s run; the first Evening Review arrives this evening.
        </EmptyState>
      ) : null}

      <div className={twoCol}>
        <SinceYesterday rows={v.since} />
        {/* D-884: shown only when something needs the viewer (the bell holds the alerts) */}
        {v.needs.length > 0 ? <NeedsYou needs={v.needs} /> : null}
      </div>

      <Section
        id="home-picks"
        title="Tonight's picks"
        more={{ href: "/picks", label: "See all picks" }}
      >
        {cards.length > 0 ? (
          <>
            <ul className={tileStrip} aria-label="Tonight's picks">
              {cards.map((p) => (
                <li key={`${p.profile}-${p.rank}`} className={tileItem} data-pick-card="">
                  <PickCard p={p} masked={masked} />
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-text-muted">
              Practice only. Picks are research ideas, not advice, and nothing here places an order.
            </p>
            <p className="mt-1">
              <SimulatedLabel />
            </p>
          </>
        ) : (
          <Empty hue="family-br" shape="picks">
            No picks yet. The first ones come after tonight&apos;s run.
          </Empty>
        )}
      </Section>

      {v.intraday ? <IntradaySection model={v.intraday} compact /> : null}

      {v.portfolios?.portfolios.some((p) => p.started) ? <PortfolioCard v={v.portfolios} /> : null}

      <SummaryCard v={v} />

      <div className={twoCol}>
        {canWatch ? (
          <Section
            id="home-watchlist"
            title="Your watchlist"
            more={{ href: "/market", label: "Open the Market tab" }}
          >
            {v.watchlist.length > 0 ? (
              <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 min-[360px]:grid-cols-2">
                {v.watchlist.map((w, n) => (
                  <li
                    key={`${w.stock}-${n}`}
                    className="min-w-0 break-words rounded-md bg-surface-2 p-2"
                  >
                    <span className="block font-semibold">{w.stock}</span>
                    {w.close !== null ? (
                      <span className="block font-mono text-sm">
                        {w.at !== null
                          ? `${w.close.toFixed(2)} (delayed, ${w.at})`
                          : `End-of-day ${w.close.toFixed(2)}`}
                      </span>
                    ) : masked ? (
                      <Masked label="Price hidden" />
                    ) : null}
                    {w.changePpm !== null ? (
                      <GainLoss value={w.changePpm} kind="ppm" />
                    ) : (
                      <NotMeasured />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty hue="sector-tech" shape="list">
                Nothing starred yet. Star a company on the Market tab and it appears here with its
                latest delayed price.
              </Empty>
            )}
          </Section>
        ) : null}

        <Section id="home-news" title="Top news" more={{ href: "/news", label: "See all news" }}>
          {v.news.hidden ? (
            <p className="text-sm text-text-muted">Company news is hidden for your role.</p>
          ) : v.news.items.length > 0 ? (
            <ul className="m-0 list-none divide-y divide-border p-0">
              {v.news.items.map((n, i) => (
                <li key={`${n.stock}-${i}`} className="min-w-0 break-words py-2 text-sm">
                  {masked ? (
                    <>
                      <span className="font-semibold">{n.stock}</span> — {n.title}
                    </>
                  ) : (
                    <Link href={`/market/${n.stock}`} className="hover:underline">
                      <span className="font-semibold">{n.stock}</span> — {n.title}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <Empty hue="sector-comms" shape="news">
              No news yet. Company announcements appear here as they are published.
            </Empty>
          )}
        </Section>

        <Section id="home-review" title="Evening Review">
          {v.review ? (
            <p className="text-sm">
              <Link href={masked ? "/reviews" : `/reviews/${v.review.d}`} className={linkCls}>
                Latest Evening Review{v.review.day ? `, ${dayText(v.review.day)}` : ""}
              </Link>
            </p>
          ) : (
            <Empty hue="brand-a" shape="list">
              The first Evening Review appears after this evening&apos;s run.
            </Empty>
          )}
        </Section>
      </div>
    </>
  );
}
