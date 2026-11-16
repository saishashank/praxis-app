// M21 C2 (UXN-320 b, D-1204): the Market table's Size column follows the one rule: shown only when at least one row has a
// value, and never for a masked role.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketTable } from "@/app/(app)/market/MarketTable";
import type { MarketRow } from "@/lib/ui/loaders/market";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/market",
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(cleanup);

const row = (n: number, sizeGroup: string | null): MarketRow => ({
  stock: `ZZ${n}`,
  slug: `ZZ${n}`,
  name: `Zed ${n}`,
  sector: "Technology",
  close: { micro: "1000000", currency: "AUD", simulated: true },
  changePpm: 10_000,
  volume: 100,
  volumeVsUsualPpm: null,
  sizeGroup,
  starred: false,
  live: null,
});
const show = (rows: MarketRow[], masked = false) =>
  render(
    <MarketTable
      caption="Companies"
      rows={rows}
      masked={masked}
      mode="star"
      starAction={async () => ({ ok: true }) as never}
      empty="none"
    />,
  );
const size = () => screen.queryByRole("columnheader", { name: "Size" });

describe("Market Size column rule", () => {
  it("shown when at least one row has a size group", () => {
    show([row(1, null), row(2, "Large")]);
    expect(size()).toBeInTheDocument();
  });
  it("absent, header and cells, when every row has none", () => {
    const { container } = show([row(1, null), row(2, null)]);
    expect(size()).toBeNull();
    expect(container.querySelectorAll("tbody tr")[0]!.querySelectorAll("td,th").length).toBe(
      container.querySelectorAll("thead th").length,
    );
  });
  it("absent for a masked role even when rows carry a value", () => {
    show([row(1, "Large")], true);
    expect(size()).toBeNull();
  });
});
