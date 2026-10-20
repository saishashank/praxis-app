// The header (docs/M7_design.md 4.2): wordmark, six tabs (desktop), region menu, alert bell, theme
// cycle and gear menu. On phones the tabs are the fixed bottom bar instead (TabBar).
import Link from "next/link";
import type { Role } from "@/lib/auth/permissions";
import type { Theme } from "@/lib/preferences/service";
import { tabsFor } from "@/lib/ui/nav";
import { AlertBell, type BellView } from "./AlertBell";
import { GearMenu } from "./GearMenu";
import { RegionMenu, type RegionMarket } from "./RegionMenu";
import { TabBar, type TabView } from "./TabBar";
import { ThemeCycle } from "./ThemeCycle";

export type HeaderProps = {
  role: Role;
  theme: Theme;
  market: RegionMarket | null;
  bell: BellView;
  /** Badge counts by tab id (Strategies: attention count, UXN-046). */
  badges?: Partial<Record<string, number>>;
  themeAction: () => Promise<void>;
  signOut: () => Promise<void>;
};

export function AppHeader({
  role,
  theme,
  market,
  bell,
  badges = {},
  themeAction,
  signOut,
}: HeaderProps) {
  const tabs: TabView[] = tabsFor(role).map((t) => ({
    id: t.id,
    label: t.label,
    href: t.href,
    badge: t.badge ? badges[t.id] : undefined,
  }));
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface">
      <div className="mx-auto flex min-h-14 w-full max-w-[1200px] items-center gap-2 px-4">
        <Link
          href="/"
          className="mr-2 inline-flex min-h-10 items-center text-lg font-semibold tracking-tight text-text"
        >
          Praxis
        </Link>
        <TabBar tabs={tabs} />
        <div className="ml-auto flex items-center gap-1">
          <RegionMenu market={market} />
          <AlertBell bell={bell} />
          <ThemeCycle theme={theme} action={themeAction} />
          <GearMenu role={role} signOut={signOut} />
        </div>
      </div>
    </header>
  );
}
