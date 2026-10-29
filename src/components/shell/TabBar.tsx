"use client";
// The six tabs (UXN-270): a top tab row from 1024 px up and a fixed bottom bar with icons and short
// labels below it (UXN-017). Both are plain links with aria-current on the active tab. The active tab
// comes from the pathname, so it is right after a client-side navigation too. Only one of the two
// navs is displayed at a time (CSS), so assistive technology reads one.
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { activeTab, type TabId } from "@/lib/ui/nav";
import { HomeIcon, MarketIcon, NewsIcon, PicksIcon, ReviewsIcon, StrategiesIcon } from "./icons";

export type TabView = { id: TabId; label: string; href: string; badge?: number };

const ICONS: Record<TabId, ReactNode> = {
  home: <HomeIcon />,
  picks: <PicksIcon />,
  market: <MarketIcon />,
  strategies: <StrategiesIcon />,
  news: <NewsIcon />,
  reviews: <ReviewsIcon />,
};

function badgeOf(t: TabView): number | null {
  return t.badge && t.badge > 0 ? t.badge : null;
}

function Badge({ n }: { n: number }) {
  return (
    <>
      <span
        aria-hidden="true"
        className="rounded-md bg-surface-2 px-1 font-mono text-[11px] leading-4 text-text"
      >
        {n > 99 ? "99+" : n}
      </span>
      <span className="sr-only">, {n} need a look</span>
    </>
  );
}

/**
 * D-201: a clicked tab shows at once that its page is loading (a bar under the label), so the menu
 * answers even while the server builds the page. A loading.tsx boundary would do this too, but it
 * streams the page and turns the 403/404 answers of forbidden()/notFound() into 200.
 */
export function TabPending() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-pending={pending ? "" : undefined}
      className={cn(
        "pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 rounded-full bg-accent",
        pending ? "animate-pulse opacity-100 delay-100" : "opacity-0",
      )}
    />
  );
}

export function TabBar({ tabs }: { tabs: TabView[] }) {
  const current = activeTab(usePathname() ?? "/");
  return (
    <>
      <nav aria-label="Main" className="hidden min-w-0 lg:block">
        <ul className="m-0 flex list-none gap-1 p-0">
          {tabs.map((t) => (
            <li key={t.id}>
              <Link
                href={t.href}
                aria-current={t.id === current ? "page" : undefined}
                className={cn(
                  "app-tab relative inline-flex min-h-10 items-center gap-1.5 rounded-md px-3 text-sm",
                  t.id === current
                    ? "bg-surface-2 font-semibold text-text"
                    : "text-text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                {t.label}
                {badgeOf(t) !== null ? <Badge n={badgeOf(t)!} /> : null}
                <TabPending />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <nav
        aria-label="Main (bottom bar)"
        className="app-tabbar fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <ul className="m-0 grid list-none grid-cols-6 p-0">
          {tabs.map((t) => (
            <li key={t.id} className="min-w-0">
              <Link
                href={t.href}
                aria-current={t.id === current ? "page" : undefined}
                className={cn(
                  "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] leading-tight",
                  t.id === current ? "font-semibold text-accent" : "text-text-muted",
                )}
              >
                {ICONS[t.id]}
                <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                  {t.label}
                  {badgeOf(t) !== null ? <Badge n={badgeOf(t)!} /> : null}
                </span>
                <TabPending />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
