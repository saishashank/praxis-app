// Home = "Today" (UX-010 to UX-017, UXN-034). A pure server component over the masked Home view model:
// it prints exactly what the loader returns, so a masked viewer never gets a code, name, price or exact
// date. Money is always shown with the Simulated label (AT-27). States: empty (nothing written yet),
// stale (banner with the last good date), error (the loader failed; the rest of the shell still works).
import Link from "next/link";
import type { ReactNode } from "react";
import { RegimeBadge } from "@/components/ui/Badges";
import { Card } from "@/components/ui/Card";
import { Banner, EmptyState } from "@/components/ui/States";
import { GainLoss, Masked, Money, NotMeasured, SimulatedLabel } from "@/components/ui/Values";
import { formatDate, formatMicro, formatPpm, plural } from "@/lib/view/format";
import type { Loaded } from "@/lib/ui/loaders/common";
import type { HomePick, HomeView } from "@/lib/ui/loaders/home";
import { WelcomeBanner } from "./WelcomeBanner";

const PROFILE_NAME: Record<string, string> = {
  aggressive: "Aggressive",
  balanced: "Balanced",
  conservative: "Conservative",
};

const linkCls = "text-accent underline";

function Section({
  title,
  id,
  more,
  children,
}: {
  title: string;
  id: string;
  more?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <Card title={title} aria-label={title} id={id}>
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

/** One plain-words sentence about the day (UXN-034). Never names a stock. */
export function daySentence(v: HomeView): string {
  const parts: string[] = [];
  parts.push(
    v.day.regime
      ? "Tonight's plans follow the market mood below."
      : "The market mood is not measured yet.",
  );
  if (v.picks.items.length > 0) {
    parts.push(`${v.picks.items.length} ${plural(v.picks.items.length, "pick")} on the list.`);
  }
  if (v.ideas.signals > 0) {
    parts.push(`${v.ideas.signals} trade ${plural(v.ideas.signals, "idea")} tonight.`);
  } else {
    parts.push("No trade ideas yet.");
  }
  return parts.join(" ");
}

function SummaryCard({ v }: { v: HomeView }) {
  const s = v.summary;
  return (
    <Card title="Pretend value today" aria-label="Pretend value today">
      <dl className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Total value (AUD)</dt>
          <dd className="mt-1 text-2xl font-semibold">
            {s.value ? <Money micro={s.value.micro} /> : <NotMeasured />}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-text-muted">Change since the last session</dt>
          <dd className="mt-1 text-lg font-semibold">
            {s.dayChange ? (
              <span className="flex flex-wrap items-baseline gap-2">
                <GainLoss value={s.dayChange.micro}>
                  {formatMicro(s.dayChange.micro, { sign: "always" })}
                </GainLoss>
                {s.dayChangePpm !== null ? (
                  <span className="text-sm text-text-muted">
                    {formatPpm(s.dayChangePpm, { sign: "always" })}
                  </span>
                ) : null}
              </span>
            ) : (
              <NotMeasured />
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-text-muted">
        {s.strategies > 0
          ? `${s.strategies} ${plural(s.strategies, "strategy", "strategies")}${s.d ? `, as of ${formatDate(s.d)}` : ""}. `
          : ""}
        Amounts are per currency and are never added across currencies.
      </p>
      <p className="mt-1">
        <SimulatedLabel />
      </p>
    </Card>
  );
}

function DayLine({ v }: { v: HomeView }) {
  const { day } = v;
  return (
    <Card title="The market today" aria-label="The market today">
      <div className="flex flex-wrap items-start gap-3">
        <RegimeBadge regime={day.regime} />
        {day.quality.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm">
            {day.quality.map((q) => (
              <li key={q.tier} className="rounded-md bg-surface-2 px-2 py-1">
                Data {q.tier}: {q.gatePass ? "ready" : "not ready"}
              </li>
            ))}
          </ul>
        ) : (
          <NotMeasured>Data quality not measured yet</NotMeasured>
        )}
      </div>
      {day.openFlags > 0 ? (
        <p className="mt-2 text-sm">
          {day.openFlags} data {plural(day.openFlags, "flag")} still open.
        </p>
      ) : null}
    </Card>
  );
}

function PickLine({ p, masked }: { p: HomePick; masked: boolean }) {
  return (
    <li className="min-w-0 break-words border-b border-border py-2 last:border-b-0">
      <span className="font-semibold">{p.stock}</span>{" "}
      <span className="text-text-muted">
        {PROFILE_NAME[p.profile] ?? p.profile} #{p.rank} · {p.family} · {p.tier}
      </span>
      {p.referenceMicro !== null ? (
        <span className="block text-sm">
          Reference <Money micro={p.referenceMicro} />
          {p.stopMicro !== null ? (
            <>
              {" "}
              · Stop <Money micro={p.stopMicro} />
            </>
          ) : null}
          {p.aimMicro !== null ? (
            <>
              {" "}
              · Aim <Money micro={p.aimMicro} />
            </>
          ) : null}
        </span>
      ) : masked ? (
        <span className="block text-sm">
          <Masked label="Prices hidden for your role" />
        </span>
      ) : null}
      {p.validUntil ? (
        <span className="block text-xs text-text-muted">Valid until {p.validUntil}</span>
      ) : null}
    </li>
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

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="mt-1 text-sm text-text-muted" data-summary="">
          {empty ? "Nothing has run yet." : daySentence(v)}
        </p>
      </div>

      {showWelcome ? <WelcomeBanner /> : null}

      {result.state === "stale" ? (
        <Banner tone="warning" title="Out of date">
          {result.text}
        </Banner>
      ) : null}

      {empty ? (
        <EmptyState title="No data yet">
          {result.text} The twelve strategies show A$600, Starting, once they exist. First trade
          ideas come after tonight&apos;s run; the first Evening Review arrives at 20:00.
        </EmptyState>
      ) : null}

      <SummaryCard v={v} />
      <DayLine v={v} />

      <p className="text-sm" data-testid="status-line">
        {role === "owner"
          ? !v.attentionCount
            ? "All systems working. "
            : `${v.attentionCount} ${plural(v.attentionCount, "thing")} in system health need a look. `
          : null}
        <Link href="/health" className={linkCls}>
          System health
        </Link>
      </p>

      <Section
        id="home-picks"
        title="Today's picks"
        more={{ href: "/picks", label: "See all picks" }}
      >
        {v.picks.items.length > 0 ? (
          <>
            <ul className="m-0 list-none p-0">
              {v.picks.items.map((p) => (
                <PickLine key={`${p.profile}-${p.rank}`} p={p} masked={masked} />
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
          <p className="text-sm text-text-muted">
            No picks yet. The first ones come after tonight&apos;s run.
          </p>
        )}
      </Section>

      <Section
        id="home-ideas"
        title="Tonight's trade ideas"
        more={{ href: "/strategies/ideas", label: "See all tonight's ideas" }}
      >
        {v.ideas.items.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {v.ideas.items.map((i, n) => (
              <li key={`${i.strategy}-${i.stock}-${n}`} className="min-w-0 break-words py-1">
                {i.href ? (
                  <Link href={i.href} className={linkCls}>
                    {i.stock}
                  </Link>
                ) : (
                  <span className="font-semibold">{i.stock}</span>
                )}{" "}
                <span className="text-text-muted">
                  {i.strategy} · taken {i.taken}, not taken {i.notTaken}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">
            No trade ideas yet — first ones after tonight&apos;s run.
          </p>
        )}
      </Section>

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
                    <span className="block font-mono text-sm">End-of-day {w.close.toFixed(2)}</span>
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
            <p className="text-sm text-text-muted">
              Nothing starred yet. Star a company on the Market tab to follow it here.
            </p>
          )}
        </Section>
      ) : null}

      <Section id="home-news" title="Top news" more={{ href: "/news", label: "See all news" }}>
        {v.news.hidden ? (
          <p className="text-sm text-text-muted">Company news is hidden for your role.</p>
        ) : v.news.items.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {v.news.items.map((n, i) => (
              <li key={`${n.stock}-${i}`} className="min-w-0 break-words py-1 text-sm">
                <span className="font-semibold">{n.stock}</span> — {n.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No news yet.</p>
        )}
      </Section>

      <Section id="home-review" title="Evening Review">
        {v.review ? (
          <p className="text-sm">
            <Link href={masked ? "/reviews" : `/reviews/${v.review.d}`} className={linkCls}>
              Latest Evening Review{v.review.day ? `, ${v.review.day}` : ""}
            </Link>
          </p>
        ) : (
          <p className="text-sm text-text-muted">First Evening Review at 20:00.</p>
        )}
      </Section>
    </>
  );
}
