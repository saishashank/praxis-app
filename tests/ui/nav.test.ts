// @vitest-environment node
// M21 A1 (D-1236, D-1214, D-1216): the five new route labels. Labels only: no tab or gear entry is added (the Owner tools
// are reached from the Picks page while the switch is on), and nothing here imports a module of the tools.
import { describe, expect, it } from "vitest";
import { activeTab, breadcrumbFor, GEAR_ITEMS, matchRoute, ROUTES, TABS } from "@/lib/ui/nav";

const NEW = [
  { path: "/recommendations", label: "Recommendations", parent: "/picks", tab: "picks" },
  { path: "/holdings", label: "Holdings", parent: "/picks", tab: "picks" },
  { path: "/trades", label: "Trades", parent: "/picks", tab: "picks" },
  { path: "/reviews/tax", label: "Tax report", parent: "/reviews", tab: "reviews" },
  { path: "/cortex/labels", label: "Label announcements", parent: "/cortex", tab: "strategies" },
] as const;

describe("M21 routes", () => {
  it.each(NEW)("$path resolves to $label under $parent", ({ path, label, parent, tab }) => {
    const node = matchRoute(path);
    expect(node).toMatchObject({ pattern: path, label, parent, tab });
    const { crumbs, backHref } = breadcrumbFor(path);
    expect(crumbs.at(-1)).toEqual({ label, href: undefined });
    expect(crumbs.at(-2)?.href).toBe(parent);
    expect(backHref).toBe(parent);
    expect(activeTab(path)).toBe(tab);
  });

  it("the breadcrumb of the labels page runs Strategies, Cortex, Label announcements", () => {
    expect(breadcrumbFor("/cortex/labels").crumbs.map((c) => c.label)).toEqual([
      "Strategies",
      "Cortex",
      "Label announcements",
    ]);
  });

  it("no tab or gear entry was added for them, and every route pattern is still unique", () => {
    const hrefs = [...TABS.map((t) => t.href), ...GEAR_ITEMS.map((g) => g.href)];
    for (const n of NEW) expect(hrefs).not.toContain(n.path);
    const patterns = ROUTES.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("the labels are plain words: no internal code", () => {
    for (const n of NEW) expect(n.label).not.toMatch(/\b[A-Z]{2,4}-\d+\b/);
  });
});

// M22 A1 (D-1444): two more labels. Labels only: no tab, gear entry or page is added.
const M22 = [
  {
    path: "/strategies/experiments/committee",
    label: "Committee trial",
    parent: "/strategies",
    tab: "strategies",
  },
  {
    path: "/reviews/experts/sources",
    label: "Expert sources",
    parent: "/reviews/experts",
    tab: "reviews",
  },
] as const;

describe("M22 routes", () => {
  it.each(M22)("$path resolves to $label under $parent", ({ path, label, parent, tab }) => {
    const node = matchRoute(path);
    expect(node).toMatchObject({ pattern: path, label, parent, tab });
    const { crumbs, backHref } = breadcrumbFor(path);
    expect(crumbs.at(-1)).toEqual({ label, href: undefined });
    expect(crumbs.at(-2)?.href).toBe(parent);
    expect(backHref).toBe(parent);
    expect(activeTab(path)).toBe(tab);
  });

  it("the breadcrumbs read Strategies, Committee trial and Reviews, Experts, Expert sources", () => {
    expect(breadcrumbFor("/strategies/experiments/committee").crumbs.map((c) => c.label)).toEqual([
      "Strategies",
      "Committee trial",
    ]);
    expect(breadcrumbFor("/reviews/experts/sources").crumbs.map((c) => c.label)).toEqual([
      "Reviews",
      "Experts",
      "Expert sources",
    ]);
  });

  it("the static sources label wins over the expert id pattern, and no tab or gear entry was added", () => {
    expect(matchRoute("/reviews/experts/sources")?.pattern).toBe("/reviews/experts/sources");
    expect(matchRoute("/reviews/experts/X-E2E1")?.pattern).toBe("/reviews/experts/[id]");
    const hrefs = [...TABS.map((t) => t.href), ...GEAR_ITEMS.map((g) => g.href)];
    for (const n of M22) expect(hrefs).not.toContain(n.path);
    const patterns = ROUTES.map((r) => r.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("the labels are plain words: no internal code", () => {
    for (const n of M22) expect(n.label).not.toMatch(/[A-Z]{2,4}-d+/);
  });
});
