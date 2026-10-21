// M7 T9 component tests (TST-128): role menus, tabs and bottom bar, gear and region menus, bell, theme
// cycle, breadcrumb, footer, banners; keyboard behaviour; 360 px layout at unit level; axe.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

import { AppShell } from "@/components/shell";
import { bellLabel } from "@/components/shell/AlertBell";
import { DISCLAIMER } from "@/components/shell/Footer";
import type { Role } from "@/lib/auth/permissions";
import type { Theme } from "@/lib/preferences/service";

const noop = async () => {};
type Over = Partial<React.ComponentProps<typeof AppShell>>;

function shell(role: Role = "owner", over: Over = {}) {
  const props = {
    role,
    theme: "dark" as Theme,
    market: { code: "AU", mode: "data_only", currency: "AUD" },
    bell: { count: 0, topTier: null },
    banners: [],
    themeAction: noop,
    signOut: noop,
    ...over,
  };
  return render(
    <AppShell {...props}>
      <main>
        <h1>Page</h1>
        <a href="/inside">Inside link</a>
      </main>
    </AppShell>,
  );
}

const top = () => screen.getByRole("navigation", { name: "Main" });
const bottom = () => screen.getByRole("navigation", { name: "Main (bottom bar)" });
const names = (el: HTMLElement) =>
  within(el)
    .getAllByRole("link")
    .map((a) => a.textContent?.trim());

beforeEach(() => {
  pathname.value = "/";
});

describe("landmarks and tabs", () => {
  it("renders header, two navs, the page, footer and a skip link that comes first", () => {
    shell();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#content");
    expect(document.getElementById("content")).toContainElement(screen.getByRole("main"));
    const first = document.querySelector("a,button");
    expect(first).toBe(skip);
  });

  it.each(["owner", "editor", "viewer"] as const)("%s sees the six tabs in both bars", (role) => {
    shell(role);
    const six = ["Home", "Picks", "Market", "Strategies", "News", "Reviews"];
    expect(names(top())).toEqual(six);
    expect(names(bottom())).toEqual(six);
  });

  it("marks the tab of the current path (also for a detail page)", () => {
    pathname.value = "/cards/12";
    shell();
    for (const nav of [top(), bottom()]) {
      const current = within(nav)
        .getAllByRole("link")
        .filter((a) => a.getAttribute("aria-current") === "page");
      expect(current.map((a) => a.textContent?.trim())).toEqual(["Strategies"]);
    }
  });

  it("marks Home on the root and no tab on a gear page", () => {
    shell();
    expect(within(top()).getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("no tab is current on Settings", () => {
    pathname.value = "/settings";
    shell();
    expect(top().querySelector("[aria-current]")).toBeNull();
  });

  it("shows the Strategies attention badge only above zero (UXN-046)", () => {
    const { unmount } = shell("owner", { badges: { strategies: 4 } });
    expect(within(top()).getByRole("link", { name: /Strategies.*4 need a look/ })).toBeTruthy();
    unmount();
    shell("owner", { badges: { strategies: 0 } });
    expect(within(top()).getByRole("link", { name: "Strategies" })).toBeInTheDocument();
  });
});

describe("gear menu (role-aware, UX-004)", () => {
  const gear = () => screen.getByRole("button", { name: "Account and settings menu" });
  const open = () => fireEvent.click(gear());
  const menuLinks = () =>
    document.getElementById(gear().getAttribute("aria-controls")!)!.querySelectorAll("a");

  it("Owner: seven pages, role line and Sign out", () => {
    shell("owner");
    expect(gear()).toHaveAttribute("aria-expanded", "false");
    open();
    expect(gear()).toHaveAttribute("aria-expanded", "true");
    expect([...menuLinks()].map((a) => a.textContent)).toEqual([
      "Settings",
      "System health",
      "Usage",
      "Ops checklist",
      "Users & roles",
      "Configuration",
      "Data review",
    ]);
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it.each(["editor", "viewer"] as const)("%s: only Settings and System health", (role) => {
    shell(role);
    open();
    expect([...menuLinks()].map((a) => a.textContent)).toEqual(["Settings", "System health"]);
    expect(screen.queryByRole("link", { name: "Users & roles" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
  });

  it("Esc closes the menu and returns focus to its button", () => {
    shell();
    open();
    const first = menuLinks()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(gear()).toHaveAttribute("aria-expanded", "false");
    expect(gear()).toHaveFocus();
  });

  it("a click outside closes it; following a link closes it", () => {
    shell();
    open();
    fireEvent.pointerDown(document.body);
    expect(gear()).toHaveAttribute("aria-expanded", "false");
    open();
    fireEvent.click(menuLinks()[0]!);
    expect(gear()).toHaveAttribute("aria-expanded", "false");
  });

  it("moving focus out of the menu closes it", () => {
    shell();
    open();
    const first = menuLinks()[0] as HTMLElement;
    first.focus();
    fireEvent.blur(first, { relatedTarget: screen.getByRole("link", { name: "Inside link" }) });
    expect(gear()).toHaveAttribute("aria-expanded", "false");
  });

  it("is a native button: reachable by Tab and activated by click (Enter/Space)", () => {
    shell();
    expect(gear().tagName).toBe("BUTTON");
    expect(gear()).not.toHaveAttribute("tabindex");
  });
});

describe("region menu (UXN-282)", () => {
  it("shows the market, status and the reason it cannot be selected", () => {
    shell();
    const btn = screen.getByRole("button", { name: "Region: AU · ASX · Data only" });
    fireEvent.click(btn);
    expect(screen.getByText("In build")).toBeInTheDocument();
    expect(screen.getByText(/strategies are not running yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Region & markets settings/ })).toHaveAttribute(
      "href",
      "/settings/region",
    );
  });
  it("an active market is shown as selected", () => {
    shell("owner", { market: { code: "AU", mode: "full", currency: "AUD" } });
    fireEvent.click(screen.getByRole("button", { name: /^Region:/ }));
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });
  it("a missing market degrades to a plain message", () => {
    shell("owner", { market: null });
    fireEvent.click(screen.getByRole("button", { name: "Region menu" }));
    expect(screen.getByText("Market information is not available.")).toBeInTheDocument();
  });
});

describe("alert bell (UXN-161)", () => {
  it("links to the alert inbox; no badge at zero", () => {
    shell();
    const bell = screen.getByRole("link", { name: "Alerts, none waiting" });
    expect(bell).toHaveAttribute("href", "/news?chip=alerts");
    expect(bell.textContent).toBe("");
  });
  it("shows the count and writes the highest tier, not just a colour", () => {
    shell("owner", { bell: { count: 3, topTier: "P0" } });
    const bell = screen.getByRole("link", {
      name: "Alerts, 3 not yet acknowledged, highest P0",
    });
    expect(bell.textContent).toContain("3");
    expect(bell.textContent).toContain("P0");
  });
  it("caps a large count", () => {
    shell("owner", { bell: { count: 250, topTier: "P2" } });
    expect(screen.getByRole("link", { name: /Alerts, 250/ }).textContent).toContain("99+");
    expect(bellLabel({ count: 1, topTier: null })).toBe("Alerts, 1 not yet acknowledged");
  });
});

describe("theme cycle (UXN-280)", () => {
  it("names the current and the next theme and submits the action", async () => {
    const action = vi.fn(async () => {});
    shell("viewer", { theme: "midnight", themeAction: action });
    const btn = screen.getByRole("button", { name: "Appearance: Midnight. Switch to Dim." });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });
  it("wraps from High contrast to Dark", () => {
    shell("owner", { theme: "high_contrast" });
    expect(
      screen.getByRole("button", { name: "Appearance: High contrast. Switch to Dark." }),
    ).toBeInTheDocument();
  });
});

describe("breadcrumb, banners, footer", () => {
  it("no breadcrumb on a tab root", () => {
    shell();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });
  it("a detail page gets a breadcrumb with the current page and a back link", () => {
    pathname.value = "/strategies/leaderboard";
    shell();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Strategies" })).toHaveAttribute(
      "href",
      "/strategies",
    );
    expect(within(crumbs).getByText("Leaderboard")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", "/strategies");
  });
  it("does not echo a code from the URL", () => {
    pathname.value = "/market/BHP";
    shell();
    expect(document.body.textContent).not.toContain("BHP");
  });
  it("renders banners from the loader and none when empty", () => {
    const { unmount } = shell("owner", {
      banners: [{ id: "mode:data_only", text: "Data only: the strategies are not running yet." }],
    });
    expect(screen.getAllByText("Data only: the strategies are not running yet.").length).toBe(1);
    expect(screen.getByRole("region", { name: "Notices" })).toBeInTheDocument();
    unmount();
    shell();
    expect(screen.queryByRole("region", { name: "Notices" })).toBeNull();
  });
  it("a reduced-header banner is a warning", () => {
    shell("owner", {
      banners: [{ id: "shell:unavailable", text: "Some header information is unavailable." }],
    });
    expect(screen.getByText("Some header information is unavailable.")).toHaveClass("m-0");
    expect(document.querySelector('[data-banner="shell:unavailable"]')).toHaveClass("text-warning");
  });
  it("footer carries the disclaimer, the Simulated link, Privacy and Terms", () => {
    shell();
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText(DISCLAIMER)).toBeInTheDocument();
    expect(within(footer).getByRole("link", { name: "What does simulated mean?" })).toHaveAttribute(
      "href",
      "/reviews/glossary#simulated",
    );
    expect(within(footer).getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(within(footer).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });
});

describe("keyboard order", () => {
  it("focus order is skip link, wordmark, tabs, region, bell, theme, gear, page, footer", () => {
    shell();
    const order = [...document.querySelectorAll<HTMLElement>("a[href], button")]
      // the bottom bar is display:none at desktop widths; in jsdom both exist, so drop it for the order
      .filter((el) => !bottom().contains(el))
      .map((el) => el.getAttribute("aria-label") ?? el.textContent?.trim());
    expect(order).toEqual([
      "Skip to main content",
      "Praxis",
      "Home",
      "Picks",
      "Market",
      "Strategies",
      "News",
      "Reviews",
      "Region: AU · ASX · Data only",
      "Alerts, none waiting",
      "Appearance: Dark. Switch to Light.",
      "Account and settings menu",
      "Inside link",
      "What does simulated mean?",
      "Privacy",
      "Terms",
    ]);
  });
  it("nothing in the shell takes a positive tabindex", () => {
    shell();
    expect(
      document.querySelector("[tabindex]:not([tabindex='-1']):not([tabindex='0'])"),
    ).toBeNull();
  });
});

describe("360 px layout (UXN-017, unit level)", () => {
  it("the bottom bar is six equal columns, fixed, and only below the desktop breakpoint", () => {
    shell();
    expect(bottom().className).toMatch(/fixed/);
    expect(bottom().className).toMatch(/bottom-0/);
    expect(bottom().className).toMatch(/lg:hidden/);
    expect(bottom().querySelector("ul")?.className).toMatch(/grid-cols-6/);
    expect(top().className).toMatch(/hidden/);
    expect(top().className).toMatch(/lg:block/);
  });
  it("bottom-bar labels do not wrap, targets are tall enough, icons are decorative", () => {
    shell();
    for (const a of within(bottom()).getAllByRole("link")) {
      expect(a.className).toMatch(/min-h-14/); // 56 px >= 48 px target (WCAG 2.5.8 and design 4.3)
      expect(a.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(a.querySelector("span")?.className).toMatch(/whitespace-nowrap/);
    }
  });
  it("shell sources use no fixed pixel widths that could force horizontal scroll", () => {
    const dir = path.resolve(import.meta.dirname, "..", "..", "src", "components", "shell");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // max-w-* is fine; a plain or min width in pixels is not
      expect(src, f).not.toMatch(/(?<![\w-])(?:min-)?w-\[\d+px\]/);
      expect(src, f).not.toMatch(/(?<![\w-])w-(?:\d{3,}|[7-9]\d)\b/);
    }
  });
  it("the page area leaves room for the bottom bar", () => {
    shell();
    expect((document.getElementById("content")!.parentElement as HTMLElement).className).toMatch(
      /pb-16/,
    );
  });
});

describe("axe (WCAG 2.0/2.1/2.2 A and AA; colour contrast is covered by the token check)", () => {
  const run = async (el: Element) =>
    axe.run(el as HTMLElement, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      rules: { "color-contrast": { enabled: false } },
    });

  it.each(["owner", "editor", "viewer"] as const)("no violations for %s", async (role) => {
    pathname.value = "/strategies/leaderboard";
    const { container } = shell(role, {
      bell: { count: 2, topTier: "P1" },
      badges: { strategies: 2 },
      banners: [{ id: "mode:data_only", text: "Data only: the strategies are not running yet." }],
    });
    const r = await run(container);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it("no violations with the gear and region menus open", async () => {
    const { container } = shell("owner");
    fireEvent.click(screen.getByRole("button", { name: "Account and settings menu" }));
    fireEvent.click(screen.getByRole("button", { name: /^Region:/ }));
    const r = await run(container);
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
