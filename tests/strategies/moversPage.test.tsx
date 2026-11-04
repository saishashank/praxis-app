// D-886: the Movers check page in each of its states (loader stubbed).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MoversCheck } from "@/lib/ui/loaders/moversCheck";

const model = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({
  requireUser: vi.fn(async () => ({ id: 1, email: "o@example.test", name: null, role: "owner" })),
}));
vi.mock("@/lib/ui/loaders/shell", () => ({ envFor: vi.fn(async () => ({})) }));
vi.mock("@/lib/ui/loaders/moversCheck", () => ({
  loadMoversCheck: vi.fn(async () => model.value),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/strategies/movers" }));

import MoversCheckPage from "@/app/(app)/strategies/movers/page";

afterEach(cleanup);

const base: MoversCheck = {
  hidden: false,
  d: "2026-11-03",
  prev: "2026-11-02",
  rises: [],
  falls: [],
  summary: { risesHeld: 0, fallsHeld: 0, fallsSold: 0 },
};

describe("Movers check page (D-886)", () => {
  it("hidden for a masked viewer, and an empty state before any prices", async () => {
    model.value = { ...base, hidden: true };
    render(await MoversCheckPage());
    expect(screen.getByText("Hidden for your access")).toBeInTheDocument();
    cleanup();
    model.value = { ...base, d: null };
    render(await MoversCheckPage());
    expect(screen.getByText("No prices stored yet")).toBeInTheDocument();
  });

  it("the summary and both lists, with the verdict words and the change", async () => {
    model.value = {
      ...base,
      rises: [
        {
          code: "AAA",
          name: "Alpha Ltd",
          changePpm: 90_000,
          verdict: "held",
          text: "Held during the rise by Follow the trend.",
          strategies: ["Follow the trend"],
        },
        {
          code: "CCC",
          name: null,
          changePpm: 50_000,
          verdict: "no_rule",
          text: "Followed, but no strategy's buy rule matched it the evening before.",
          strategies: [],
        },
      ],
      falls: [
        {
          code: "BBB",
          name: "Beta Ltd",
          changePpm: -80_000,
          verdict: "sold_by_stop",
          text: "Held by Buy the dip and sold that day by the stop loss.",
          strategies: ["Buy the dip"],
        },
      ],
      summary: { risesHeld: 1, fallsHeld: 0, fallsSold: 1 },
    } satisfies MoversCheck;
    render(await MoversCheckPage());
    expect(document.querySelector("[data-movers-summary]")).toHaveTextContent(
      "held 1 of the 2 biggest rises; 1 of the 1 biggest falls were held (1 sold that day)",
    );
    expect(screen.getByRole("link", { name: "AAA" })).toHaveAttribute("href", "/market/AAA");
    expect(screen.getByText("Alpha Ltd")).toBeInTheDocument();
    expect(screen.getByText("Held")).toBeInTheDocument();
    expect(screen.getByText("No rule matched")).toBeInTheDocument();
    expect(screen.getByText("Sold by the stop")).toBeInTheDocument();
    expect(screen.getByText(/▼/)).toBeInTheDocument();
  });

  it("an empty list says so", async () => {
    model.value = { ...base };
    render(await MoversCheckPage());
    expect(screen.getAllByText("No company in this list for the session.")).toHaveLength(2);
  });
});
