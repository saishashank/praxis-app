// D-205: the Market sections on their own, with made-up models: the page controls of each movers list,
// the size switch with All, the colour-coded size letter, the spinner and the empty states.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SizeBadge } from "@/app/(app)/market/MarketTable";
import {
  CompaniesSection,
  MarketStatus,
  MoversSection,
  SectionLoading,
  SectorsSection,
} from "@/app/(app)/market/sections";
import type { MarketList, MarketModel, MarketRow } from "@/lib/ui/loaders/market";
import { mq } from "./query";

afterEach(cleanup);

const row = (n: number): MarketRow => ({
  stock: `ZZ${n}`,
  slug: `ZZ${n}`,
  name: `Zed ${n}`,
  sector: "Technology",
  close: { micro: "1000000", currency: "AUD", simulated: true },
  changePpm: 10_000,
  volume: 100,
  volumeVsUsualPpm: null,
  sizeGroup: n % 2 === 0 ? "Large" : "Small",
  starred: false,
});
const list = (number: number, total: number): MarketList => ({
  rows: [row(number * 10 + 1), row(number * 10 + 2)],
  page: { number, size: 10, total },
});
const model = (over: Partial<MarketModel> = {}): MarketModel => ({
  state: "ok",
  masked: false,
  size: "all",
  sized: true,
  d: "2026-10-28",
  staleText: null,
  up: list(2, 25),
  down: list(1, 5),
  traded: list(1, 12),
  sectors: [{ sector: "Technology", count: 2, avgChangePpm: 10_000 }],
  all: list(1, 2),
  note: null,
  ...over,
});
const star = async () => ({ ok: true as const, starred: true, changed: true });
const show = async (el: ReactElement) => {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(el);
  });
  return r;
};

describe("Market sections (D-205)", () => {
  it("each movers list pages on its own and keeps the other lists' pages", async () => {
    const q = mq({ upPage: 2 });
    await show(
      <MoversSection model={Promise.resolve(model())} q={q} mode="star" starAction={star} />,
    );
    const up = screen.getByRole("navigation", { name: "Biggest rises pages" });
    expect(within(up).getByText("Page 2 of 3")).toBeInTheDocument();
    expect(within(up).getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "/market",
    );
    expect(within(up).getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/market?up=3",
    );
    // five falls fit on one page: no controls
    expect(screen.queryByRole("navigation", { name: "Biggest falls pages" })).toBeNull();
    const traded = screen.getByRole("navigation", { name: "Most traded pages" });
    expect(within(traded).getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "/market?up=2&traded=2",
    );
  });

  it("labels each company Large, Mid or Small with a coloured letter", async () => {
    const { container } = await show(<SizeBadge size="Large" />);
    expect(container.textContent).toContain("L");
    expect(screen.getByText("Large company")).toHaveClass("sr-only");
    expect(container.querySelector(".bg-chart-1")).not.toBeNull();
    cleanup();
    expect((await show(<SizeBadge size={null} />)).container.innerHTML).toBe("");
    expect((await show(<SizeBadge size="Huge" />)).container.innerHTML).toBe("");
  });

  it("the size switch has All first and marks the current size", async () => {
    await show(<MarketStatus model={Promise.resolve(model({ size: "mid" }))} q={mq()} />);
    const nav = screen.getByRole("navigation", { name: "Company size" });
    const links = within(nav).getAllByRole("link");
    // UXR-002: the current size has three cues (fill, check icon, aria-current plus a hidden "Selected")
    expect(links.map((l) => l.textContent)).toEqual(["All", "Large", "Mid (Selected)", "Small"]);
    expect(within(nav).getByRole("link", { name: /Mid/ }).querySelector("svg")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "All" }).querySelector("svg")).toBeNull();
    expect(within(nav).getByRole("link", { name: /Mid/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "All" })).toHaveAttribute("href", "/market");
    expect(screen.getByText("Latest data: 2026-10-28.")).toBeInTheDocument();
  });

  it("shows the out-of-date banner, and no size switch for a masked user", async () => {
    await show(
      <MarketStatus
        model={Promise.resolve(model({ masked: true, state: "stale", staleText: "Old data." }))}
        q={mq()}
      />,
    );
    expect(screen.getByText("Old data.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Company size" })).toBeNull();
    expect(screen.queryByText(/Size groups need 60 sessions/)).toBeNull();
  });

  it("every section says when there is no data yet", async () => {
    const none = Promise.resolve(model({ state: "empty" }));
    for (const el of [
      <MoversSection key="m" model={none} q={mq()} mode="star" starAction={star} />,
      <SectorsSection key="s" model={none} q={mq()} />,
      <CompaniesSection key="c" model={none} q={mq()} mode="star" starAction={star} />,
    ]) {
      cleanup();
      await show(el);
      expect(screen.getByText("No market data yet")).toBeInTheDocument();
    }
  });

  it("sectors without data say so; a chosen sector can be cleared", async () => {
    await show(<SectorsSection model={Promise.resolve(model({ sectors: [] }))} q={mq()} />);
    expect(screen.getByText("No sector data yet")).toBeInTheDocument();
    cleanup();
    await show(
      <CompaniesSection
        model={Promise.resolve(model())}
        q={mq({ open: ["all"], sector: "Technology", page: 1 })}
        mode="star"
        starAction={star}
      />,
    );
    expect(screen.getByRole("link", { name: "Show all sectors" })).toHaveAttribute(
      "href",
      "/market?open=all",
    );
  });

  it("the spinner is one status with words", async () => {
    await show(<SectionLoading label="Loading the sectors" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the sectors");
  });

  it("UXR-051: a row carries its sector hue (rail and chip), an outcome-coloured change, a Watch label", async () => {
    const { container } = await show(
      <MoversSection model={Promise.resolve(model())} q={mq()} mode="star" starAction={star} />,
    );
    const rail = container.querySelector('[data-sector-rail="tech"]') as HTMLElement;
    expect(rail).not.toBeNull();
    expect(rail.getAttribute("style")).toContain("--color-sector-tech-fill");
    expect(container.querySelector('[data-kind="sector"]')?.textContent).toContain("Technology");
    const up = container.querySelector('[data-outcome="up"]') as HTMLElement;
    expect(up).toHaveClass("text-positive", "tabular-nums");
    expect(up.className).not.toContain("font-mono");
    expect(up.textContent).toContain("▲");
    expect(container.textContent).toContain("Watch");
  });

  it("UXR-051: the sector heat grid tints each tile with its hue and shows arrow and number as text", async () => {
    const { container } = await show(
      <SectorsSection
        model={Promise.resolve(
          model({
            sectors: [
              { sector: "Technology", count: 2, avgChangePpm: 20_000 },
              { sector: "Banks", count: 3, avgChangePpm: -10_000 },
              { sector: "Mystery", count: 1, avgChangePpm: 0 },
            ],
          }),
        )}
        q={mq()}
      />,
    );
    const tiles = [...container.querySelectorAll("[data-sector-hue]")] as HTMLElement[];
    expect(tiles.map((t) => t.dataset.sectorHue)).toEqual([
      "sector-tech",
      "sector-financials",
      "none",
    ]);
    expect(tiles[0]!.getAttribute("style")).toContain("--color-sector-tech-fill");
    expect(tiles[2]!.getAttribute("style")).toContain("--color-outcome-flat-fill");
    expect(tiles[0]!.textContent).toContain("▲ +2.0%");
    expect(tiles[1]!.textContent).toContain("▼ −1.0%");
    // the text sits on the tint as body text, not a fill colour
    expect(tiles[0]).toHaveClass("text-text");
  });
});
