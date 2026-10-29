// M7 T15 page tests (TST-128, AT-25, AT-26, AT-27; ch.16 16.24): the Market tab and the company page per
// role with a synthetic database. Checks: search "zz" returns starred-able rows with an "i" (UXN-270);
// Viewers get no star but keep the "i"; a masked Editor gets a disabled star with its reason; masked
// pages contain no code, name, price or link (DAT-124, decision 21); the company page shows candles and
// key numbers to the Owner and derived numbers only to masked users; honest labels (End-of-day price, no
// order controls); not-found for a real code from a masked user; axe.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { findLeaks } from "@/lib/view/mask";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, fullWorld, NAMES, type World } from "../loaders/world";

const user = vi.hoisted(() => ({
  value: { id: 1, email: "o@example.test", name: null, role: "owner" },
}));
const dbs = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
const lc = vi.hoisted(() => ({ createChart: vi.fn() }));

vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => user.value) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbs.main, authDb: () => dbs.auth }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/market",
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("lightweight-charts", () => ({
  ColorType: { Solid: "solid" },
  LineSeries: "line",
  CandlestickSeries: "candles",
  HistogramSeries: "histogram",
  createSeriesMarkers: vi.fn(),
  createChart: (...a: unknown[]) => lc.createChart(...a),
}));

import MarketPage from "@/app/(app)/market/page";
import CompanyPage from "@/app/(app)/market/[code]/page";
import { requireUser } from "@/lib/auth/guard";

let w: World;
const asId = (who: "owner" | "editor" | "viewer") => {
  user.value = {
    id: w.ids[who],
    email: `${who}@example.test`,
    name: null,
    role: who,
  };
};

beforeAll(async () => {
  w = await fullWorld();
  await w.main.execute(
    `INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES
       ('AU', '2026-10-19', 'ZZUP', 'active', 'U1')`,
  );
});
afterAll(cleanupTempDbs);
beforeEach(() => {
  cleanup();
  dbs.main = w.main;
  dbs.auth = w.auth;
  vi.mocked(requireUser).mockClear();
  lc.createChart.mockReset();
  lc.createChart.mockImplementation(() => ({
    addSeries: () => ({
      setData: vi.fn(),
      priceScale: () => ({ applyOptions: vi.fn() }),
    }),
    timeScale: () => ({ fitContent: vi.fn() }),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  }));
  asId("owner");
});

/** D-205: the page streams its sections; wait until no section shows its spinner. */
const market = async (sp: Record<string, string> = {}) => {
  const el = await MarketPage({ searchParams: Promise.resolve(sp) });
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(el);
  });
  await waitFor(() => expect(r.container.querySelector(".animate-spin")).toBeNull());
  return r;
};
const company = async (code: string) =>
  render(await CompanyPage({ params: Promise.resolve({ code }) }));

const axeRun = (el: Element) =>
  axe.run(el as HTMLElement, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
    rules: { "color-contrast": { enabled: false } },
  });

describe("the Market tab for the Owner", () => {
  it("asks the guard first and has one h1, the end-of-day note and no order control", async () => {
    const { container } = await market();
    expect(requireUser).toHaveBeenCalledWith("read", "/market");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Market" })).toBeInTheDocument();
    expect(container.textContent).toMatch(/end-of-day prices/i);
    expect(container.textContent).toMatch(/Nothing here places an order/);
    expect(screen.queryByRole("button", { name: /\b(buy|sell|order)\b/i })).toBeNull();
  });

  it("D-205: only Top movers is open at first; a section heading opens or closes it", async () => {
    await market();
    const movers = screen.getByRole("link", { name: /^Top moverss*(Show|Hide)$/ });
    const sectors = screen.getByRole("link", { name: /^Sectorss*(Show|Hide)$/ });
    expect(movers).toHaveAttribute("aria-expanded", "true");
    expect(movers).toHaveAttribute("href", "/market?open=");
    expect(sectors).toHaveAttribute("aria-expanded", "false");
    expect(sectors).toHaveAttribute("href", "/market?open=movers%2Csectors");
    expect(screen.queryByText("Average day change by sector")).toBeNull();
    cleanup();
    await market({ open: "sectors" });
    expect(screen.getByRole("link", { name: /^Sectorss*(Show|Hide)$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.queryByRole("heading", { name: "Biggest rises" })).toBeNull();
  });

  it("search 'zz' lists matching companies, each with a star and an 'i' (UXN-270)", async () => {
    await market({ q: "zz" });
    const list = screen.getByRole("list", { name: "Search results" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(list).getByText("Zed Upward Holdings")).toBeInTheDocument();
    for (const code of CODES) {
      expect(
        within(list).getByRole("button", { name: `Add ${code} to watchlist` }),
      ).toBeInTheDocument();
      expect(
        within(list).getByRole("button", { name: `Company overview for ${code}` }),
      ).toBeInTheDocument();
    }
  });

  it("search with no match says so, and an invalid term is ignored", async () => {
    await market({ q: "qqqq" });
    expect(screen.getByText("No companies match that search.")).toBeInTheDocument();
    cleanup();
    await market({ q: "a<b" });
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("Top movers lists rises, falls and most traded with day change, arrow and sign", async () => {
    const { container } = await market();
    expect(screen.getByRole("heading", { name: "Biggest rises" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Biggest falls" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most traded" })).toBeInTheDocument();
    // D-200: this world's thinly traded codes stay out of the movers before size groups exist,
    // so the day change, arrow and sign are checked on All companies
    expect(container.textContent).toContain("No company rose at the last close.");
    cleanup();
    const all = (await market({ tab: "all" })).container;
    expect(all.textContent).toContain("▲");
    expect(all.textContent).toContain("▼");
    expect(all.textContent).toContain("+5.00%");
    expect(all.textContent).toContain("-10.00%");
  });

  it("All companies shows name, code, price label, size and sector, and pages with links", async () => {
    const { container } = await market({ tab: "all" });
    expect(screen.getAllByText("End-of-day price").length).toBeGreaterThan(0);
    // D-193: this young world has under 60 sessions of history, so no size groups yet
    expect(container.textContent).toContain("Size groups need 60 sessions of price history");
    expect(container.textContent).toContain("Technology");
    const link = screen.getAllByRole("link", { name: /ZZUP/ })[0]!;
    expect(link).toHaveAttribute("href", "/market/ZZUP");
  });

  it("Sectors shows the heat grid and a link per sector", async () => {
    await market({ tab: "sectors" });
    expect(screen.getByRole("link", { name: "Technology (1)" })).toHaveAttribute(
      "href",
      "/market?open=sectors%2Call&sector=Technology",
    );
  });

  it("filters All companies by sector", async () => {
    const { container } = await market({ tab: "all", sector: "Technology" });
    expect(container.textContent).toContain("Zed Upward Holdings");
    expect(container.textContent).not.toContain("Zed Downward Mining");
    expect(screen.getByRole("link", { name: "Show all sectors" })).toBeInTheDocument();
  });

  it("a bad tab or page is not found", async () => {
    await expect(market({ tab: "nope" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(market({ tab: "all", page: "0" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the index strip shows the change and a text alternative", async () => {
    await w.main.execute(
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES ('AU','ZZX','2026-10-16',1000000,1000000,1000000,1000000,'t','2026-10-16T06:00:00.000Z','2026-10-16T06:00:00.000Z'),
              ('AU','ZZX','2026-10-19',1010000,1010000,1010000,1010000,'t','2026-10-19T06:00:00.000Z','2026-10-19T06:00:00.000Z')`,
    );
    await market();
    expect(screen.getByRole("heading", { name: "Main index" })).toBeInTheDocument();
    expect(screen.getByText(/ZZX, close of 2026-10-19/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Main index, last month/ })).toBeInTheDocument();
  });

  it("has no axe violations (all three tabs)", async () => {
    const sets: Array<Record<string, string>> = [{ q: "zz" }, { tab: "all" }, { tab: "sectors" }];
    for (const sp of sets) {
      cleanup();
      const { container } = await market(sp);
      expect((await axeRun(container)).violations).toEqual([]);
    }
  });
});

describe("the Market tab for an Editor (masked) and a Viewer (masked)", () => {
  it("shows Stock A / Stock B with derived numbers and no code, name, price or link", async () => {
    asId("editor");
    const { container } = await market();
    expect(container.textContent).toContain("Stock A");
    expect(container.textContent).toContain("Stock B");
    expect(container.textContent).not.toMatch(/ZZ|Zed |A\$|\$\d/);
    expect(findLeaks(container.textContent, CODES, NAMES)).toEqual([]);
    expect(container.querySelectorAll("a[href^='http']")).toHaveLength(0);
    expect(screen.getByText("Some details are hidden")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/ZZUP|ZZDN|ZZOTH/);
  });

  it("switches search off with the reason in words", async () => {
    asId("editor");
    await market({ q: "zz" });
    expect(screen.getByLabelText("Search by company name or code")).toBeDisabled();
    expect(screen.getByText(/Search is switched off for you/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("an Editor sees a disabled star with its reason; a Viewer sees no star; both keep the 'i'", async () => {
    asId("editor");
    await market();
    const stars = screen.getAllByRole("button", { name: /Add Stock . to watchlist: .*hidden/ });
    expect(stars.length).toBeGreaterThan(0);
    for (const s of stars) expect(s).toBeDisabled();
    expect(
      screen.getAllByRole("button", { name: /Company overview for Stock/ }).length,
    ).toBeGreaterThan(0);
    cleanup();
    asId("viewer");
    await market();
    expect(screen.queryByRole("button", { name: /watchlist/ })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: /Company overview for Stock/ }).length,
    ).toBeGreaterThan(0);
  });

  it("hides sectors and size groups (they would reveal the companies)", async () => {
    asId("viewer");
    await market({ tab: "sectors" });
    expect(screen.getByText("Sectors are hidden")).toBeInTheDocument();
    cleanup();
    const { container } = await market({ tab: "all" });
    expect(container.textContent).not.toMatch(/Technology|Materials|Large|Mid/);
  });

  it("has no axe violations", async () => {
    asId("editor");
    const { container } = await market();
    expect((await axeRun(container)).violations).toEqual([]);
  });
});

describe("the company page for the Owner", () => {
  it("shows the name, code, sector, latest close with its label, star and 'i'", async () => {
    asId("owner");
    const { container } = await company("ZZUP");
    expect(requireUser).toHaveBeenCalledWith("read", "/market/[code]");
    expect(
      screen.getByRole("heading", { level: 1, name: "Zed Upward Holdings" }),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("Technology");
    expect(container.textContent).toContain("A$10.50");
    expect(container.textContent).toMatch(/End-of-day price, /);
    expect(screen.getByRole("button", { name: "Add ZZUP to watchlist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Company overview for ZZUP" })).toBeInTheDocument();
    expect(screen.getByText("+5.00%")).toBeInTheDocument();
  });

  it("has the chart with range chips 1M to 2Y, a table alternative, the attribution and no 5Y", async () => {
    await company("ZZUP");
    const group = screen.getByRole("group", { name: "Chart range" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1M", "3M", "6M", "1Y", "2Y"]);
    expect(screen.getByRole("button", { name: "Show as table" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /end-of-day bars from/ })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "TradingView Lightweight Charts" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(lc.createChart).toHaveBeenCalled());
  });

  it("shows key numbers with 'Not available' where the source has none, and Our activity", async () => {
    const { container } = await company("ZZUP");
    const key = screen.getByRole("heading", { name: "Key numbers" }).closest("section")!;
    expect(within(key).getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
    expect(key.textContent).toContain("52-week range");
    expect(key.textContent).toMatch(/usual/);
    expect(screen.getByRole("heading", { name: "Our activity" })).toBeInTheDocument();
    expect(container.textContent).toContain("Simulated: nothing here is a real order");
    expect(screen.getByRole("link", { name: /trade idea/ })).toBeInTheDocument();
  });

  it("lists announcements with their link", async () => {
    await company("ZZUP");
    const news = screen
      .getByRole("heading", { name: "News and announcements" })
      .closest("section")!;
    const link = within(news).getByRole("link", { name: /full-year result/ });
    expect(link).toHaveAttribute("href", "https://news.example.test/doc.pdf");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("an unknown code is not found", async () => {
    await expect(company("ZZNONE")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(company("..%2Fx")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has no axe violations", async () => {
    const { container } = await company("ZZUP");
    expect((await axeRun(container)).violations).toEqual([]);
  });
});

describe("the company page for masked users (decision 21)", () => {
  it("shows derived numbers only: no chart, price, code, name, link or Our activity", async () => {
    asId("editor");
    const { container } = await company("stock-b");
    expect(screen.getByRole("heading", { level: 1, name: "Stock B" })).toBeInTheDocument();
    expect(screen.queryByTestId("company-chart")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Chart" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Our activity" })).toBeNull();
    expect(container.textContent).toMatch(/Against 50-day average/);
    expect(container.textContent).toContain("+5.00%");
    expect(container.textContent).not.toMatch(/A\$\d/);
    expect(findLeaks(container.textContent, CODES, NAMES)).toEqual([]);
    expect(container.innerHTML).not.toMatch(/ZZUP|ZZDN|ZZOTH|news\.example/);
    expect(lc.createChart).not.toHaveBeenCalled();
  });

  it("a real code from a masked user is the same 404 as an unknown one", async () => {
    asId("viewer");
    await expect(company("ZZUP")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(company("stock-q")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("has no axe violations", async () => {
    asId("viewer");
    const { container } = await company("stock-b");
    expect((await axeRun(container)).violations).toEqual([]);
  });
});
