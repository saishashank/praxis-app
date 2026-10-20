// M7 T9: the navigation model (docs/M7_design.md 4.2). Role menus, the three-level rule, breadcrumbs,
// the tab for a path, the theme cycle.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES } from "../../e2e/pages";
import { ROLES, can } from "@/lib/auth/permissions";
import { THEMES } from "@/lib/preferences/service";
import {
  GEAR_ITEMS,
  MAX_LEVELS,
  ROUTES,
  TABS,
  THEME_LABEL,
  THEME_ORDER,
  activeTab,
  breadcrumbFor,
  gearFor,
  levelOf,
  matchRoute,
  nextTheme,
  regionLabel,
  regionStatus,
  tabsFor,
} from "@/lib/ui/nav";

const SIX = ["Home", "Picks", "Market", "Strategies", "News", "Reviews"];

describe("tabs (UXN-270)", () => {
  it("are the six final tabs in order, for every role", () => {
    expect(TABS.map((t) => t.label)).toEqual(SIX);
    for (const role of ROLES) expect(tabsFor(role).map((t) => t.label)).toEqual(SIX);
  });
  it("show nothing without a valid role", () => {
    expect(tabsFor(null)).toEqual([]);
    expect(tabsFor(undefined)).toEqual([]);
    expect(gearFor(null)).toEqual([]);
  });
  it("only Strategies carries a badge source (UXN-046)", () => {
    expect(TABS.filter((t) => t.badge).map((t) => t.id)).toEqual(["strategies"]);
  });
});

describe("gear menu per role (UX-004)", () => {
  it("Owner sees all seven items", () => {
    expect(gearFor("owner").map((g) => g.label)).toEqual([
      "Settings",
      "System health",
      "Usage",
      "Ops checklist",
      "Users & roles",
      "Configuration",
      "Data review",
    ]);
  });
  it.each(["editor", "viewer"] as const)("%s sees Settings and System health only", (role) => {
    expect(gearFor(role).map((g) => g.label)).toEqual(["Settings", "System health"]);
  });
  it("every item is allowed by the same matrix the guards use", () => {
    for (const role of ROLES) {
      for (const g of gearFor(role)) expect(can(role, g.action), `${role} ${g.href}`).toBe(true);
    }
  });
  it("agrees with the page registry for every page that exists", () => {
    for (const g of GEAR_ITEMS) {
      const page = PAGES.find((p) => p.path === g.href);
      if (page) expect(page.action, g.href).toBe(g.action);
    }
  });
});

describe("route model: at most three levels (UXN-033)", () => {
  it("every route is 1..3 levels deep and its parent exists", () => {
    const patterns = new Set(ROUTES.map((r) => r.pattern));
    expect(patterns.size).toBe(ROUTES.length);
    for (const r of ROUTES) {
      if (r.parent) expect(patterns.has(r.parent), `${r.pattern} parent`).toBe(true);
      const level = levelOf(r.pattern);
      expect(level, r.pattern).toBeGreaterThanOrEqual(1);
      expect(level, r.pattern).toBeLessThanOrEqual(MAX_LEVELS);
    }
  });
  it("every tab and gear destination is a top-level route", () => {
    for (const t of TABS) expect(levelOf(t.href), t.href).toBe(1);
    for (const g of GEAR_ITEMS) expect(levelOf(g.href), g.href).toBe(1);
  });
  it("every route under a tab names that tab", () => {
    for (const r of ROUTES) {
      if (r.pattern === "/" || !r.tab) continue;
      const top = TABS.find((t) => t.id === r.tab)!;
      const chainTop = ROUTES.find((n) => n.tab === r.tab && !n.parent)!;
      expect(chainTop.pattern, r.pattern).toBe(top.href);
    }
  });
  it("covers every page.tsx under src/app/(app) (a new page must be added to the model)", () => {
    const root = path.resolve(import.meta.dirname, "..", "..", "src", "app", "(app)");
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "page.tsx") {
          const rel = path.relative(root, path.dirname(full)).split(path.sep).filter(Boolean);
          found.push("/" + rel.join("/"));
        }
      }
    };
    walk(root);
    expect(found.length).toBeGreaterThan(5);
    for (const f of found)
      expect(
        ROUTES.some((r) => r.pattern === f),
        f,
      ).toBe(true);
  });
});

describe("matchRoute", () => {
  it("prefers static segments over bracketed ones", () => {
    expect(matchRoute("/strategies/leaderboard")?.label).toBe("Leaderboard");
    expect(matchRoute("/strategies/abc123")?.label).toBe("Strategy");
    expect(matchRoute("/picks/track-record")?.label).toBe("Track record");
    expect(matchRoute("/picks/9")?.label).toBe("Why this pick");
  });
  it("ignores a query, a hash and a trailing slash", () => {
    expect(matchRoute("/news/?chip=alerts#x")?.pattern).toBe("/news");
  });
  it("returns null for an unknown path", () => {
    expect(matchRoute("/nope")).toBeNull();
    expect(matchRoute("/a/b/c/d/e")).toBeNull();
  });
});

describe("breadcrumb and back link", () => {
  it("none on a tab root, a gear page or an unknown path", () => {
    expect(breadcrumbFor("/").crumbs).toEqual([]);
    expect(breadcrumbFor("/strategies").crumbs).toEqual([]);
    expect(breadcrumbFor("/health").crumbs).toEqual([]);
    expect(breadcrumbFor("/nope").crumbs).toEqual([]);
  });
  it("two levels: tab then page, back goes to the tab", () => {
    const b = breadcrumbFor("/strategies/leaderboard");
    expect(b.crumbs).toEqual([
      { label: "Strategies", href: "/strategies" },
      { label: "Leaderboard", href: undefined },
    ]);
    expect(b.backHref).toBe("/strategies");
  });
  it("three levels: Strategies > Tonight's trade ideas > Decision card", () => {
    const b = breadcrumbFor("/cards/17");
    expect(b.crumbs.map((c) => c.label)).toEqual([
      "Strategies",
      "Tonight's trade ideas",
      "Decision card",
    ]);
    expect(b.backHref).toBe("/strategies/ideas");
  });
  it("gear sub-pages crumb back to Settings", () => {
    expect(breadcrumbFor("/settings/appearance").crumbs.map((c) => c.label)).toEqual([
      "Settings",
      "Appearance",
    ]);
  });
  it("never echoes a URL segment (it may be a stock code a masked user must not see)", () => {
    for (const p of ["/market/BHP", "/picks/CBA", "/reviews/learned/families/ZZ1", "/cards/WES"]) {
      const text = JSON.stringify(breadcrumbFor(p));
      expect(text, p).not.toMatch(/BHP|CBA|ZZ1|WES/);
    }
  });
  it("never links to a bracketed ancestor", () => {
    for (const r of ROUTES) {
      const b = breadcrumbFor(r.pattern.replace(/\[[^\]]+\]/g, "x"));
      for (const c of b.crumbs) if (c.href) expect(c.href).not.toContain("[");
    }
  });
});

describe("activeTab", () => {
  it.each([
    ["/", "home"],
    ["/picks", "picks"],
    ["/picks/track-record", "picks"],
    ["/market/ZZ1", "market"],
    ["/strategies/leaderboard", "strategies"],
    ["/cards/5", "strategies"],
    ["/news", "news"],
    ["/reviews/2026-10-20", "reviews"],
    ["/reviews/learned", "reviews"],
    ["/learning", "reviews"],
    ["/picks/unknown/deeper/still", "picks"],
  ])("%s -> %s", (p, tab) => {
    expect(activeTab(p)).toBe(tab);
  });
  it.each(["/settings", "/health", "/usage", "/privacy", "/nope"])("%s belongs to no tab", (p) => {
    expect(activeTab(p)).toBeNull();
  });
});

describe("region", () => {
  it("labels the market like the spec example", () => {
    expect(regionLabel({ code: "AU", mode: "full" })).toBe("AU · ASX · Active");
    expect(regionLabel({ code: "AU", mode: "data_only" })).toBe("AU · ASX · Data only");
    expect(regionLabel({ code: "IN", mode: "weird" })).toBe("IN · weird");
    expect(regionLabel(null)).toBe("Region");
  });
  it("only an active market is selectable; the others say why", () => {
    expect(regionStatus({ code: "AU", mode: "full" })).toEqual({
      selectable: true,
      text: "Active",
    });
    const d = regionStatus({ code: "AU", mode: "data_only" });
    expect(d.selectable).toBe(false);
    expect(d.reason).toBeTruthy();
    expect(regionStatus({ code: "AU", mode: "off" }).selectable).toBe(false);
  });
});

describe("theme cycle (UXN-280)", () => {
  it("covers exactly the six stored themes, each with a name", () => {
    expect([...THEME_ORDER].sort()).toEqual([...THEMES].sort());
    for (const t of THEMES) expect(THEME_LABEL[t]).toBeTruthy();
  });
  it("steps through all six and wraps", () => {
    const seen: string[] = [];
    let t = THEME_ORDER[0]!;
    for (let i = 0; i < THEMES.length; i++) {
      seen.push(t);
      t = nextTheme(t);
    }
    expect(new Set(seen).size).toBe(6);
    expect(t).toBe(THEME_ORDER[0]);
    expect(nextTheme("high_contrast")).toBe("dark");
  });
});
