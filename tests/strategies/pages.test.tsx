// M7 T12 page tests (TST-128, AT-25, AT-26, AT-27): the Strategies list, one strategy and the
// leaderboard, per role, with a synthetic database. Checks the acceptance criteria of UXN-046, 046a, 051,
// 053, 054, 055, 057, 060, 068; the tied group of ARN-078; masking (no code, name, price or exact date for
// a masked viewer); the Owner-only revert through the existing audited route; and axe.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { CARD_UP, leaks, type Both } from "../loaders/seed";
import { strategiesWorld } from "./world";

const user = vi.hoisted(() => ({
  value: { id: 1, email: "o@example.test", name: null, role: "owner" },
}));
const dbs = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
const refresh = vi.hoisted(() => vi.fn());
const lc = vi.hoisted(() => ({
  createChart: vi.fn(),
  markers: vi.fn(),
  series: [] as Array<{
    setData: ReturnType<typeof vi.fn>;
    createPriceLine: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => user.value) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main, authDb: () => dbs.auth }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh }),
  usePathname: () => "/strategies",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("lightweight-charts", () => ({
  ColorType: { Solid: "solid" },
  LineStyle: { Dotted: 1, Dashed: 2, LargeDashed: 3 },
  LineSeries: "line",
  AreaSeries: "area",
  createSeriesMarkers: (...a: unknown[]) => lc.markers(...a),
  createChart: (...a: unknown[]) => lc.createChart(...a),
}));

import StrategiesPage from "@/app/(app)/strategies/page";
import StrategyPage from "@/app/(app)/strategies/[execution]/page";
import LeaderboardPage from "@/app/(app)/strategies/leaderboard/page";
import { requireUser } from "@/lib/auth/guard";

const ROLE = {
  owner: { id: 1, email: "o@example.test", name: null, role: "owner" },
  editor: { id: 2, email: "e@example.test", name: null, role: "editor" },
  viewer: { id: 3, email: "v@example.test", name: null, role: "viewer" },
} as const;
const as = (r: keyof typeof ROLE) => {
  user.value = ROLE[r];
};

let w: Both;
beforeAll(async () => {
  w = await strategiesWorld();
});
afterAll(cleanupTempDbs);
beforeEach(() => {
  cleanup();
  dbs.main = w.main;
  dbs.auth = w.auth;
  as("owner");
  lc.markers.mockReset();
  lc.series.length = 0;
  lc.createChart.mockReset();
  lc.createChart.mockImplementation(() => ({
    addSeries: () => {
      const s = { setData: vi.fn(), createPriceLine: vi.fn(), applyOptions: vi.fn() };
      lc.series.push(s);
      return s;
    },
    timeScale: () => ({ fitContent: vi.fn() }),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  }));
});

const list = async (sp: Record<string, string> = {}) =>
  render(await StrategiesPage({ searchParams: Promise.resolve(sp) }));
const one = async (id: string) =>
  render(await StrategyPage({ params: Promise.resolve({ execution: id }) }));
const board = async (sp: Record<string, string> = {}) =>
  render(await LeaderboardPage({ searchParams: Promise.resolve(sp) }));

const axeRun = (el: Element) =>
  axe.run(el as HTMLElement, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
    rules: { "color-contrast": { enabled: false } },
  });

describe("the list", () => {
  it("asks the guard first and shows one h1, the Simulated label and the page links", async () => {
    await list();
    expect(requireUser).toHaveBeenCalledWith("read", "/strategies");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Strategies" })).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Leaderboard" })).toHaveAttribute(
      "href",
      "/strategies/leaderboard",
    );
  });

  it("starts with Needs attention (UXN-046) and lists every strategy below it", async () => {
    await list();
    expect(
      screen.getByRole("heading", { level: 2, name: "Needs attention (1)" }),
    ).toBeInTheDocument();
    const group = screen
      .getByRole("heading", { level: 2, name: /Needs attention/ })
      .closest("section")!;
    expect(within(group).getByText(/Paused by the Owner/)).toBeInTheDocument();
    expect(within(group).getByText(/Within 15% of its loss limit/)).toBeInTheDocument();
    expect(within(group).getAllByRole("article")).toHaveLength(1);
    const all = screen
      .getByRole("heading", { level: 2, name: "All strategies" })
      .closest("section")!;
    expect(within(all).getAllByRole("article")).toHaveLength(2);
  });

  it("shows the short name, the money type and the one-liner, and the hover lines (UXN-039)", async () => {
    await list();
    const all = screen
      .getByRole("heading", { level: 2, name: "All strategies" })
      .closest("section")!;
    const tile = within(all).getByRole("heading", { name: "Follow the trend" }).closest("article")!;
    expect(within(tile).getByText("Plain shares")).toBeInTheDocument();
    expect(within(tile).getByText(/Buys shares that just hit a 1-year high/)).toBeInTheDocument();
    fireEvent.click(within(tile).getByRole("button", { name: "About Follow the trend" }));
    expect(await screen.findByText("How it buys")).toBeInTheDocument();
    for (const t of ["How it sells", "Works best when", "Main risk"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });

  it("shows the sparkline, the regime badge with its exact name, and the exact label (UXN-052, 057, 060)", async () => {
    await list();
    const all = screen
      .getByRole("heading", { level: 2, name: "All strategies" })
      .closest("section")!;
    const tile = within(all).getByRole("heading", { name: "Follow the trend" }).closest("article")!;
    expect(
      within(tile).getByRole("img", { name: /Follow the trend value, last 3 sessions/ }),
    ).toBeInTheDocument();
    expect(within(tile).getByText("NEUTRAL")).toBeInTheDocument();
    expect(within(tile).getByText("UNVALIDATED")).toBeInTheDocument();
    expect(within(tile).getByText("Not proven yet")).toBeInTheDocument();
    // The red warning sign of the open position is shown with its words, not by colour alone.
    expect(within(tile).getByText("Triggered")).toBeInTheDocument();
  });

  it("offers the four sort chips, remembers the choice and lets ?sort= win for a visit", async () => {
    await list();
    const chips = screen.getByRole("group", { name: "Sort the strategies" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Best so far", "Closest to goal", "Most at risk", "A to Z"]);
    expect(within(chips).getByRole("button", { name: "Best so far" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    cleanup();
    await list({ sort: "az" });
    expect(screen.getByRole("button", { name: "A to Z" })).toHaveAttribute("aria-pressed", "true");
    const names = screen
      .getByRole("heading", { level: 2, name: "All strategies" })
      .closest("section")!
      .querySelectorAll("article h3");
    expect([...names].map((h) => h.textContent)).toEqual(
      ["Follow the trend", "Good company, good news"].sort(),
    );
    // A remembered sort is used when no ?sort= is given.
    await w.auth.execute({
      sql: "INSERT INTO user_preference (user_id, prefs_json, updated_at) VALUES (1, ?, 'x') ON CONFLICT (user_id) DO UPDATE SET prefs_json = excluded.prefs_json",
      args: [JSON.stringify({ strategies_sort: "risk" })],
    });
    cleanup();
    await list();
    expect(screen.getByRole("button", { name: "Most at risk" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await w.auth.execute("DELETE FROM user_preference");
  });

  it("holds no code, name or id for a masked viewer, and for the Editor", async () => {
    for (const r of ["viewer", "editor"] as const) {
      cleanup();
      as(r);
      const { container } = await list();
      expect(leaks(container.innerHTML)).toEqual([]);
    }
  });

  it("says so when nothing exists yet", async () => {
    const none = await (await import("../loaders/seed")).emptyDbs();
    dbs.main = none.main;
    dbs.auth = none.auth;
    await list();
    expect(screen.getByText("No strategies yet")).toBeInTheDocument();
    expect(screen.getByText(/No rounds yet/)).toBeInTheDocument();
  });

  it.each(["owner", "editor", "viewer"] as const)("has no axe violations for %s", async (r) => {
    as(r);
    const { container } = await list();
    expect((await axeRun(container)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("one strategy", () => {
  it("shows the round line, the chart, the drawdown and the controls toggle", async () => {
    await one("E01");
    expect(screen.getByRole("heading", { level: 1, name: "Follow the trend" })).toBeInTheDocument();
    expect(
      screen.getByText(/Round 1 · started Mon 12 Oct 2026 · 3 sessions held/),
    ).toBeInTheDocument();
    expect(screen.getByTestId("nav-chart")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Drop from the highest value so far" }),
    ).toBeInTheDocument();
    // 600 -> 610 -> 630: no drop yet, and the replay-based figure says it is not measured.
    expect(screen.getByText(/Largest drop so far in this round: 0\.00%/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare with matched controls" })).toBeEnabled();
    await waitFor(() => expect(lc.createChart).toHaveBeenCalledTimes(2));
  });

  it("scrubs with the keyboard and reads date, value, day change and market mood (UXN-051)", async () => {
    await one("E01");
    const chart = screen.getByTestId("nav-chart");
    const readout = () => document.querySelector("[aria-live=polite]")!.textContent!;
    expect(readout()).toContain("2026-10-19: A$630.00");
    expect(readout()).toContain("market mood Mixed (NEUTRAL)");
    expect(readout()).toContain("+A$20.00 on the day");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(readout()).toContain("2026-10-16: A$610.00");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(readout()).toContain("2026-10-15: A$600.00");
    expect(readout()).not.toContain("on the day");
  });

  it("marks buys and sells for the Owner and links each trade to its Decision Card (UXN-054)", async () => {
    await one("E01");
    await waitFor(() => expect(lc.markers).toHaveBeenCalled());
    const markers = lc.markers.mock.calls[0]![1] as Array<{
      shape: string;
      text: string;
      time: string;
    }>;
    expect(markers.filter((m) => m.shape === "arrowUp").length).toBe(3);
    expect(markers.filter((m) => m.shape === "arrowDown").length).toBe(1);
    expect(markers.map((m) => m.time)).toEqual([...markers.map((m) => m.time)].sort());
    const strip = screen.getByRole("list", { name: "Trades, newest first" });
    const buttons = within(strip).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[0]!);
    const detail = screen.getByRole("region", { name: "Selected trade" });
    expect(within(detail).getByText("3 shares")).toBeInTheDocument();
    expect(within(detail).getByText("A$12.00")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /Decision Card/ })).toHaveAttribute(
      "href",
      `/cards/${encodeURIComponent(CARD_UP)}`,
    );
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next trade" }));
    expect(buttons[1]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
  });

  it("overlays only the matched controls and the zero-edge benchmark when toggled (UXN-068)", async () => {
    await one("E01");
    await waitFor(() => expect(lc.series.length).toBeGreaterThan(0));
    const before = lc.series.length;
    fireEvent.click(screen.getByRole("button", { name: "Compare with matched controls" }));
    expect(screen.getByRole("button", { name: "Compare with matched controls" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Matched control C2 (dashed line)")).toBeInTheDocument();
    expect(
      screen.getByText(/Zero-edge benchmark \(long dashes\): expected end value A\$585\.00/),
    ).toBeInTheDocument();
    await waitFor(() => expect(lc.series.length).toBeGreaterThan(before));
    // No outside market index or "random control" wording anywhere.
    expect(document.body.textContent).not.toMatch(/random control|S&P|ASX 200 index/i);
  });

  it("shows the table alternative of the chart", async () => {
    await one("E01");
    fireEvent.click(screen.getByRole("button", { name: "Show as table" }));
    expect(screen.queryByTestId("nav-chart")).toBeNull();
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
  });

  it("compares with the matched control and gives the 3, 6 and 12 month chances with ranges", async () => {
    await one("E01");
    const card = screen
      .getByRole("heading", { name: "Compared with matched controls" })
      .closest("section")!;
    expect(within(card).getByText("12.0%")).toBeInTheDocument();
    expect(within(card).getByText(/90% range 2\.0% to 50\.0%/)).toBeInTheDocument();
    expect(within(card).getByText("+5.0 points")).toBeInTheDocument();
    expect(within(card).getByText("3 months")).toBeInTheDocument();
    expect(within(card).getByText("12 months")).toBeInTheDocument();
    expect(within(card).getByText(/reaches the goal in 3\.0% of 2000 trials/)).toBeInTheDocument();
  });

  it("lists past rounds and, for the L version, the sleeve at 10 and 5 times as hypothetical", async () => {
    await one("E02");
    const rounds = screen.getByRole("heading", { name: "Past rounds" }).closest("section")!;
    expect(within(rounds).getAllByText(/Round [12]/).length).toBeGreaterThanOrEqual(2);
    expect(
      within(rounds).getAllByText(/Hit the loss limit, Sun 20 Sep 2026/).length,
    ).toBeGreaterThan(0);
    // D-191: the L twin (E04) runs nothing and is listed nowhere; its own page still explains the
    // hypothetical sleeve
    cleanup();
    await one("E04");
    const sleeve = screen.getByRole("heading", { name: "Leverage sleeve" }).closest("section")!;
    expect(within(sleeve).getByText(/Hypothetical leverage/)).toBeInTheDocument();
    expect(
      within(sleeve).getByRole("heading", { name: "Designed leverage (10 times)" }),
    ).toBeInTheDocument();
    expect(
      within(sleeve).getByRole("heading", { name: "Reality-adjusted (5 times)" }),
    ).toBeInTheDocument();
    expect(within(sleeve).getAllByText("12").length).toBeGreaterThanOrEqual(2);
    cleanup();
    await one("E01");
    expect(screen.queryByRole("heading", { name: "Leverage sleeve" })).toBeNull();
  });

  it("shows the version history, with a working Revert only for the Owner", async () => {
    await one("E01");
    const history = screen.getByRole("heading", { name: "Version history" }).parentElement!;
    expect(within(history).getAllByText("F1.v2").length).toBeGreaterThan(0);
    expect(within(history).getAllByText(/Starting version/).length).toBeGreaterThan(0);
    expect(within(history).getAllByText("passed").length).toBeGreaterThan(0);
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(within(history).getAllByRole("button", { name: "Revert to F1.v1" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(fetchMock).not.toHaveBeenCalled(); // nothing happens before the confirm button
    fireEvent.click(within(dialog).getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/learning/families/F1/rollback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ to_version: "F1.v1", confirm: true });
    expect(await screen.findByText(/Scheduled/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("asks twice for a killed family and shows a refusal in words", async () => {
    await one("E01");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "second_confirmation_required", family: "F1" }, { status: 409 }),
      )
      .mockResolvedValueOnce(Response.json({ error: "market_data_only" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getAllByRole("button", { name: "Revert to F1.v1" })[0]!);
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Revert" }),
    );
    expect(await screen.findByText(/kill switch/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm again" }));
    expect(await screen.findByText(/data-only mode/)).toBeInTheDocument();
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({
      confirm_killed: true,
    });
  });

  it("disables Revert with its reason for an Editor and hides it from a Viewer", async () => {
    as("editor");
    await one("E01");
    const btns = screen.getAllByRole("button", { name: "Revert" });
    expect(btns.length).toBeGreaterThan(0);
    for (const b of btns) expect(b).toBeDisabled();
    expect(screen.getAllByText("Only the Owner can revert a version.").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Revert to F1.v1" })).toBeNull();
    cleanup();
    as("viewer");
    await one("E01");
    expect(screen.queryByRole("button", { name: /Revert/ })).toBeNull();
  });

  it("masks codes, names, prices and exact dates for the Editor and the Viewer, and drops the markers", async () => {
    for (const r of ["viewer", "editor"] as const) {
      cleanup();
      lc.markers.mockReset();
      as(r);
      const { container } = await one("E01");
      expect(leaks(container.innerHTML)).toEqual([]);
      const strip = screen.getByRole("list", { name: "Trades, newest first" });
      expect(
        within(strip)
          .getAllByRole("button")
          .map((b) => b.textContent)
          .join(" "),
      ).toMatch(/Stock [A-Z]/);
      expect(strip.textContent).toMatch(/\d{4}-W\d{2}/);
      expect(strip.textContent).not.toMatch(/2026-10-1\d/);
      fireEvent.click(within(strip).getAllByRole("button")[0]!);
      const detail = screen.getByRole("region", { name: "Selected trade" });
      expect(detail.textContent).not.toMatch(/A\$12\.00|A\$10\.00|A\$11\.00/);
      expect(
        within(detail)
          .getByRole("link", { name: /Decision Card/ })
          .getAttribute("href"),
      ).toMatch(/^\/cards\/ck%3A[0-9a-f]{16}$/);
      await new Promise((res) => setTimeout(res, 20));
      expect(lc.markers).not.toHaveBeenCalled();
      expect(container.textContent).toMatch(/Trade markers on the chart are for the Owner/);
    }
  });

  it("answers an unknown strategy and a control with not found", async () => {
    await expect(one("E99")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(one("C2-F1")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(one("E01'; DROP TABLE x;--")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("says what is missing when no round has started", async () => {
    await w.main.execute(
      "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E05','AU','E','F3','U','v1','P5')",
    );
    await one("E05");
    expect(screen.getByText("Nothing to chart yet")).toBeInTheDocument();
    expect(screen.getByText("No round has started yet")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-chart")).toBeNull();
  });

  it.each(["owner", "editor", "viewer"] as const)("has no axe violations for %s", async (r) => {
    as(r);
    const { container } = await one("E02");
    await act(async () => {});
    expect((await axeRun(container)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the leaderboard", () => {
  it("shows overlapping strategies as one tied group, listed A to Z, never by point estimate (AT-25, ARN-078)", async () => {
    await board();
    expect(screen.getByRole("heading", { level: 1, name: "Leaderboard" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ranked strategies (2 compared)" }),
    ).toBeInTheDocument();
    const group = screen
      .getByRole("heading", { name: /Tied group: 2 strategies/ })
      .closest("section")!;
    expect(group).toHaveAttribute("data-tied", "true");
    expect(within(group).getByText(/listed A to Z and not put in order/)).toBeInTheDocument();
    const table = within(group).getAllByRole("table")[0]!;
    const names = [...table.querySelectorAll(":scope > tbody > tr > th")].map((c) => c.textContent);
    expect(names).toEqual(["Follow the trend", "Good company, good news"]); // D-191: no L twins
    // E01 has the higher estimate, E02 sorts later by name: the order is by name only.
    expect(names).toEqual([...names].sort());
  });

  it("uses exactly the UX-020 columns and adds no invented metric (UXN-053)", async () => {
    await board();
    const group = screen.getByRole("heading", { name: /Tied group/ }).closest("section")!;
    const heads = [
      ...within(group).getAllByRole("table")[0]!.querySelectorAll(":scope > thead th"),
    ].map((h) => h.textContent);
    expect(heads).toEqual([
      "Strategy",
      "Evidence label",
      "Rounds",
      "Chance of ending (12 months)",
      "Value change vs start",
      "Zero-edge benchmark",
      "Costs",
      "Largest drop",
      "Recent trend",
    ]);
    expect(document.body.textContent).not.toMatch(/Sharpe|Win Rate|This Week|This Month/i);
  });

  it("shows chances with ranges, the control difference, the zero-edge benchmark and the exact label", async () => {
    await board();
    const row = screen
      .getAllByRole("rowheader")
      .find((c) => c.textContent === "Follow the trend")!
      .closest("tr")!;
    expect(within(row).getByText(/Goal 12\.0% \(2\.0% to 50\.0%\)/)).toBeInTheDocument();
    expect(within(row).getByText(/Minus matched control C2: \+A\$10\.00/)).toBeInTheDocument();
    expect(within(row).getByText("Goal 3.0%")).toBeInTheDocument();
    expect(within(row).getByText("UNVALIDATED")).toBeInTheDocument();
    expect(within(row).getByText(/Separate rounds/)).toBeInTheDocument();
  });

  it("lists the controls and renders a card list for phones", async () => {
    const { container } = await board();
    const ctl = screen.getByRole("heading", { name: "Controls" }).closest("section")!;
    expect(within(ctl).getAllByText(/Control C2/).length).toBeGreaterThan(0);
    // Below 600 px the DataTable shows this list instead of the table (UXN-017).
    const cards = container.querySelectorAll("ul.sm\\:hidden");
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(cards[0]!.querySelectorAll(":scope > li").length).toBeGreaterThan(0);
  });

  it("toggles the cost profile from stored re-cost rows", async () => {
    await board({ cost: "P3" });
    expect(screen.getAllByText("Value under cost profile P3").length).toBeGreaterThan(0);
    expect(screen.getAllByText("A$628.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "P3" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "As traded" })).toHaveAttribute(
      "href",
      "/strategies/leaderboard",
    );
  });

  it("filters round counts by market mood with the regime chips (UXN-057)", async () => {
    await board({ regime: "RISK-ON" });
    expect(screen.getByRole("link", { name: "Calm and rising" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getAllByText("Rounds started in Calm and rising").length).toBeGreaterThan(0);
    expect(screen.getByText(/Chances and ranges cover all rounds/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All market moods" })).toHaveAttribute(
      "href",
      "/strategies/leaderboard?regime=RISK-ON".replace("?regime=RISK-ON", ""),
    );
  });

  it.each(["editor", "viewer"] as const)("holds no code, name or id for %s", async (r) => {
    as(r);
    const { container } = await board({ cost: "P3", regime: "NEUTRAL" });
    expect(leaks(container.innerHTML)).toEqual([]);
  });

  it.each(["owner", "editor", "viewer"] as const)("has no axe violations for %s", async (r) => {
    as(r);
    const { container } = await board();
    expect((await axeRun(container)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("evidence not stored yet", () => {
  it("every figure says Not measured yet and every strategy is without enough evidence", async () => {
    const bare = await strategiesWorld();
    // Rename the run so the page finds no run for the market (stored rows are append-only).
    bare.main.execute = ((orig) => async (q: unknown) => {
      const sql = typeof q === "string" ? q : (q as { sql: string }).sql;
      if (/FROM replay_stat WHERE run_id LIKE/.test(sql))
        return { rows: [], columns: [], rowsAffected: 0 };
      return orig(q as never);
    })(bare.main.execute.bind(bare.main)) as typeof bare.main.execute;
    dbs.main = bare.main;
    await board();
    expect(
      screen.getByText("No strategy has enough finished rounds to be ranked yet"),
    ).toBeInTheDocument();
    const section = screen
      .getByRole("heading", { name: "Not enough evidence yet" })
      .closest("section")!;
    expect(section.querySelector("table")!.querySelectorAll(":scope > tbody > tr").length).toBe(2);
    expect(within(section).getAllByText("Not measured yet").length).toBeGreaterThan(4);
  });
});
