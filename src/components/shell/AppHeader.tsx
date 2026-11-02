// The header (docs/M7_design.md 4.2; UXR-005): wordmark, six tabs (desktop) and exactly three controls:
// the region/mode chip, the alert bell and the avatar (account menu). There is no theme toggle here;
// Settings > Appearance owns the theme. On phones the tabs are the fixed bottom bar instead (TabBar).
import Link from "next/link";
import type { ReactNode } from "react";
import type { Role } from "@/lib/auth/permissions";
import { tabsFor } from "@/lib/ui/nav";
import { AlertBell, type BellView } from "./AlertBell";
import { GearMenu, type Account } from "./GearMenu";
import { RegionMenu, type RegionMarket } from "./RegionMenu";
import { HomeIcon, MarketIcon, NewsIcon, PicksIcon, ReviewsIcon, StrategiesIcon } from "./icons";
import { TabBar, type TabView } from "./TabBar";

const ICONS: Record<TabView["id"], ReactNode> = {
  home: <HomeIcon />,
  picks: <PicksIcon />,
  market: <MarketIcon />,
  strategies: <StrategiesIcon />,
  news: <NewsIcon />,
  reviews: <ReviewsIcon />,
};

export type HeaderProps = {
  role: Role;
  market: RegionMarket | null;
  bell: BellView;
  /** Badge counts by tab id (Strategies: attention count, UXN-046). */
  badges?: Partial<Record<string, number>>;
  signOut: () => Promise<void>;
  /** Who is signed in, for the avatar and the identity row of the account menu (UXR-004). */
  account?: Account;
};

export function AppHeader({ role, market, bell, badges = {}, signOut, account }: HeaderProps) {
  const tabs: TabView[] = tabsFor(role).map((t) => ({
    id: t.id,
    label: t.label,
    href: t.href,
    badge: t.badge ? badges[t.id] : undefined,
    icon: ICONS[t.id],
  }));
  return (
    <header className="app-header sticky top-0 z-40 border-b border-border bg-surface">
      <div className="page-frame flex min-h-14 items-center gap-2">
        <Link
          href="/"
          className="mr-2 inline-flex min-h-10 items-center gap-2 text-lg font-semibold tracking-tight text-text"
        >
          {/* From 600 px (sm) the full logo with its tagline (Owner 2026-11-01, D-730): 40 px high, well
              above the 96 px minimum width. On phones the "Signal P" mark and wordmark (docs/brand/BRAND.md). */}
          <span className="hidden items-center sm:inline-flex">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/praxis-logo-tagline-dark.svg"
              alt="Praxis — Learn. Earn. Repeat."
              width={121}
              height={40}
              className="logo-dark h-10 w-auto"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/praxis-logo-tagline-light.svg"
              alt="Praxis — Learn. Earn. Repeat."
              width={121}
              height={40}
              className="logo-light h-10 w-auto"
            />
          </span>
          <span className="inline-flex items-center gap-2 sm:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/praxis-mark-dark.svg"
              alt=""
              width={30}
              height={24}
              className="logo-dark app-mark h-6 w-auto"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/praxis-mark-light.svg"
              alt=""
              width={30}
              height={24}
              className="logo-light app-mark h-6 w-auto"
            />
            <span className="app-brand">Praxis</span>
          </span>
        </Link>
        <TabBar tabs={tabs} />
        <div className="ml-auto flex items-center gap-1">
          <RegionMenu market={market} />
          <AlertBell bell={bell} />
          <GearMenu role={role} account={account} signOut={signOut} />
        </div>
      </div>
    </header>
  );
}
