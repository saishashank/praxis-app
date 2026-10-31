// The navigation model of the app shell (docs/M7_design.md 4.2; UXN-270, UXN-033, UXN-282, UXN-280).
// ONE source for the six tabs, the gear (account) menu, the region label, the breadcrumb and the theme
// cycle. Pure data and functions: no server imports, so client components may use it. Role filtering
// uses the same `can()` matrix as the server guards (ROL-102a); the pages and actions still refuse
// regardless of what a menu shows (UX-004).
import { can, type Role } from "@/lib/auth/permissions";
import type { Theme } from "@/lib/preferences/service";

export type TabId = "home" | "picks" | "market" | "strategies" | "news" | "reviews";

export type Tab = {
  id: TabId;
  label: string;
  href: string;
  /** Needed role action; every signed-in role reads the six tabs. */
  action: string;
  /** Badge source: only Strategies has one (attention count, UXN-046; none at zero). */
  badge?: "attention";
};

/** UXN-270: the final tab list (decision 1, D-128). */
export const TABS: readonly Tab[] = [
  { id: "home", label: "Home", href: "/", action: "read" },
  { id: "picks", label: "Picks", href: "/picks", action: "read" },
  { id: "market", label: "Market", href: "/market", action: "read" },
  {
    id: "strategies",
    label: "Strategies",
    href: "/strategies",
    action: "read",
    badge: "attention",
  },
  { id: "news", label: "News", href: "/news", action: "read" },
  { id: "reviews", label: "Reviews", href: "/reviews", action: "read" },
];

export type GearItem = { id: string; label: string; href: string; action: string };

/** The gear menu (ch.09 top note): pages that keep their full page but are not tabs. */
export const GEAR_ITEMS: readonly GearItem[] = [
  { id: "settings", label: "Settings", href: "/settings", action: "own_preferences" },
  { id: "health", label: "System health", href: "/health", action: "read" },
  { id: "usage", label: "Usage", href: "/usage", action: "admin" },
  { id: "ops", label: "Ops checklist", href: "/ops", action: "admin" },
  { id: "users", label: "Users & roles", href: "/users", action: "admin" },
  { id: "audit", label: "Audit log", href: "/audit", action: "admin" },
  { id: "config", label: "Configuration", href: "/config", action: "admin" },
  { id: "review", label: "Data review", href: "/review", action: "admin" },
];

export const BELL_HREF = "/news?chip=alerts"; // UXN-157 / UXN-161: the bell opens the alert inbox
export const REGION_SETTINGS_HREF = "/settings/region"; // Settings -> Region & markets (UXN-282)
export const GLOSSARY_HREF = "/reviews/glossary"; // consistent help (WCAG 3.2.6), UXN-032
export const MAX_LEVELS = 3; // UXN-033: every page is at most three levels from a tab

export const tabsFor = (role: Role | null | undefined): Tab[] =>
  TABS.filter((t) => can(role, t.action));
export const gearFor = (role: Role | null | undefined): GearItem[] =>
  GEAR_ITEMS.filter((g) => can(role, g.action));

// ---- routes: labels, parents, tabs ----------------------------------------------------------------

type RouteNode = {
  /** "/a/[x]": a bracketed segment matches any one segment. */
  pattern: string;
  /** Generic label: the real segment is never echoed (it may be a code a masked user must not see). */
  label: string;
  parent?: string;
  tab?: TabId;
};

export const ROUTES: readonly RouteNode[] = [
  { pattern: "/", label: "Home", tab: "home" },
  { pattern: "/picks", label: "Picks", tab: "picks" },
  { pattern: "/picks/track-record", label: "Track record", parent: "/picks", tab: "picks" },
  { pattern: "/picks/[id]", label: "Why this pick", parent: "/picks", tab: "picks" },
  { pattern: "/alerts", label: "My alerts", parent: "/picks", tab: "picks" },
  { pattern: "/market", label: "Market", tab: "market" },
  { pattern: "/market/[code]", label: "Company", parent: "/market", tab: "market" },
  { pattern: "/strategies", label: "Strategies", tab: "strategies" },
  {
    pattern: "/strategies/leaderboard",
    label: "Leaderboard",
    parent: "/strategies",
    tab: "strategies",
  },
  { pattern: "/strategies/risk", label: "Risk overview", parent: "/strategies", tab: "strategies" },
  {
    pattern: "/strategies/ideas",
    label: "Tonight's trade ideas",
    parent: "/strategies",
    tab: "strategies",
  },
  {
    pattern: "/strategies/[execution]",
    label: "Strategy",
    parent: "/strategies",
    tab: "strategies",
  },
  {
    pattern: "/cards/[id]",
    label: "Decision card",
    parent: "/strategies/ideas",
    tab: "strategies",
  },
  { pattern: "/what-if", label: "What-if", parent: "/strategies", tab: "strategies" },
  { pattern: "/cortex", label: "Cortex", parent: "/strategies", tab: "strategies" },
  { pattern: "/news", label: "News", tab: "news" },
  { pattern: "/reviews", label: "Reviews", tab: "reviews" },
  { pattern: "/reviews/[date]", label: "Evening review", parent: "/reviews", tab: "reviews" },
  {
    pattern: "/reviews/learned",
    label: "What the system learned",
    parent: "/reviews",
    tab: "reviews",
  },
  {
    pattern: "/reviews/learned/families/[family]",
    label: "Family",
    parent: "/reviews/learned",
    tab: "reviews",
  },
  {
    pattern: "/reviews/learned/lessons/[id]",
    label: "Lesson",
    parent: "/reviews/learned",
    tab: "reviews",
  },
  {
    pattern: "/reviews/learned/challengers/[id]",
    label: "Challenger",
    parent: "/reviews/learned",
    tab: "reviews",
  },
  {
    pattern: "/reviews/learned/compare",
    label: "Compare",
    parent: "/reviews/learned",
    tab: "reviews",
  },
  { pattern: "/reviews/glossary", label: "Glossary", parent: "/reviews", tab: "reviews" },
  {
    pattern: "/reviews/alerts",
    label: "Monthly alerts report",
    parent: "/reviews",
    tab: "reviews",
  },
  // Gear and public pages.
  { pattern: "/settings", label: "Settings" },
  { pattern: "/settings/appearance", label: "Appearance", parent: "/settings" },
  { pattern: "/settings/region", label: "Region & markets", parent: "/settings" },
  { pattern: "/settings/time", label: "Time and alerts", parent: "/settings" },
  { pattern: "/settings/alerts", label: "Alerts", parent: "/settings" },
  { pattern: "/settings/quiet-hours", label: "Quiet hours", parent: "/settings" },
  { pattern: "/settings/sign-out-everywhere", label: "Sign out everywhere", parent: "/settings" },
  { pattern: "/settings/about", label: "About", parent: "/settings" },
  { pattern: "/health", label: "System health" },
  { pattern: "/usage", label: "Usage" },
  { pattern: "/ops", label: "Ops checklist" },
  { pattern: "/ops/go-live", label: "Go-live record", parent: "/health" },
  { pattern: "/audit", label: "Audit log" },
  { pattern: "/users", label: "Users & roles" },
  { pattern: "/config", label: "Configuration" },
  { pattern: "/review", label: "Data review" },
  { pattern: "/privacy", label: "Privacy" },
  { pattern: "/terms", label: "Terms" },
];

const BY_PATTERN = new Map(ROUTES.map((r) => [r.pattern, r]));

const pathSegments = (p: string): string[] => p.split(/[?#]/)[0]!.split("/").filter(Boolean);

/** The route node for a pathname; static segments win over bracketed ones. Unknown paths give null. */
export function matchRoute(pathname: string): RouteNode | null {
  const path = pathSegments(pathname);
  let best: { node: RouteNode; score: number } | null = null;
  for (const node of ROUTES) {
    const pat = pathSegments(node.pattern);
    if (pat.length !== path.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      const s = pat[i]!;
      if (s.startsWith("[") && s.endsWith("]")) continue;
      if (s !== path[i]) {
        ok = false;
        break;
      }
      score++;
    }
    if (ok && (best === null || score > best.score)) best = { node, score };
  }
  return best?.node ?? null;
}

/** The chain of route nodes from the top (a tab or a gear page) down to the node. */
export function chainOf(node: RouteNode): RouteNode[] {
  const out: RouteNode[] = [];
  let cur: RouteNode | undefined = node;
  while (cur && out.length <= ROUTES.length) {
    out.unshift(cur);
    cur = cur.parent ? BY_PATTERN.get(cur.parent) : undefined;
  }
  return out;
}

/** Levels below the top (1 = a tab or gear page itself). */
export const levelOf = (pattern: string): number => {
  const n = BY_PATTERN.get(pattern);
  return n ? chainOf(n).length : 0;
};

export type NavCrumb = { href?: string; label: string };

/** Breadcrumb for a pathname (UXN-033). Empty for a top-level page or an unknown path. */
export function breadcrumbFor(pathname: string): { crumbs: NavCrumb[]; backHref?: string } {
  const node = matchRoute(pathname);
  if (!node) return { crumbs: [] };
  const chain = chainOf(node);
  if (chain.length < 2) return { crumbs: [] };
  const crumbs = chain.map((n, i) => ({
    label: n.label,
    // Only static patterns link; a bracketed ancestor cannot be linked to without its value.
    href: i < chain.length - 1 && !n.pattern.includes("[") ? n.pattern : undefined,
  }));
  const parent = chain[chain.length - 2]!;
  return { crumbs, backHref: parent.pattern.includes("[") ? undefined : parent.pattern };
}

/** The tab a pathname belongs to (for aria-current), or null for gear and public pages. */
export function activeTab(pathname: string): TabId | null {
  const node = matchRoute(pathname);
  if (node) return node.tab ?? null;
  const p = "/" + pathSegments(pathname).join("/");
  for (const t of TABS) {
    if (t.href !== "/" && (p === t.href || p.startsWith(t.href + "/"))) return t.id;
  }
  return null;
}

// ---- region and theme ---------------------------------------------------------------------------------

const MODE_LABEL: Record<string, string> = {
  off: "Off",
  data_only: "Data only",
  full: "Active",
};
const EXCHANGE: Record<string, string> = { AU: "ASX" };

/** "AU · ASX · Data only" (UXN-282). */
export function regionLabel(market: { code: string; mode: string } | null): string {
  if (!market) return "Region";
  return [market.code, EXCHANGE[market.code], MODE_LABEL[market.mode] ?? market.mode]
    .filter(Boolean)
    .join(" · ");
}

export type RegionStatus = { selectable: boolean; text: string; reason?: string };

/** MKT-106 status of a market for the region menu; only an active market can be selected. */
export function regionStatus(market: { code: string; mode: string }): RegionStatus {
  if (market.mode === "full") return { selectable: true, text: "Active" };
  if (market.mode === "data_only") {
    return {
      selectable: false,
      text: "In build",
      reason: "Data is collected but the strategies are not running yet.",
    };
  }
  return { selectable: false, text: "Not started", reason: "This market is switched off." };
}

/** Theme cycle order and names (UXN-280). A test keeps this equal to THEMES in the preference service. */
export const THEME_ORDER: readonly Theme[] = [
  "dark",
  "light",
  "system",
  "midnight",
  "dim",
  "high_contrast",
];
export const THEME_LABEL: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  system: "Match device",
  midnight: "Midnight",
  dim: "Dim",
  high_contrast: "High contrast",
};
export function nextTheme(theme: Theme): Theme {
  const i = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!;
}

// ---- region chip (UXR-005) ------------------------------------------------------------------------------

/** The visible chip text, "AU · ASX" (the mode is a dot, not words: UXR-005). */
export function regionChip(market: { code: string } | null): string {
  if (!market) return "Region";
  return [market.code, EXCHANGE[market.code]].filter(Boolean).join(" · ");
}

/** The dot of the chip: green only for an active market, grey in data-only and off mode. */
export const regionDot = (mode: string): "active" | "grey" => (mode === "full" ? "active" : "grey");
