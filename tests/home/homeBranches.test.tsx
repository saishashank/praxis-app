// Home content branches (UXN-034, UXR-007, UXR-020, D-884, D-907): the component rendered from a
// hand-built view model, so every wording variant (live or end of day, gain / loss / unchanged, empty
// sections, masked viewer) is pinned without a database.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeContent, daySentence, moodOf } from "@/app/(app)/home/HomeContent";
import type { HomePick, HomeView, StrategyTile } from "@/lib/ui/loaders/home";
import type { Loaded } from "@/lib/ui/loaders/common";

vi.mock("@/app/(app)/home/actions", () => ({ dismissWelcomeAction: vi.fn() }));

afterEach(cleanup);

const m = (micro: number) => ({ micro, currency: "AUD" as const, simulated: true as const });
const ISO = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;

function baseView(): HomeView {
  return {
    headline: [],
    dataAtLabel: null,
    dayLabel: null,
    nextRun: "tonight 18:10",
    dataOnly: false,
    since: [],
    needs: [],
    picksTotal: 0,
    summary: { strategies: 0, d: null, tiles: [] },
    day: { regime: null, regimeD: null, quality: [], openFlags: 0, index: null },
    picks: { d: null, items: [] },
    intraday: null,
    portfolios: null,
    ideas: { d: null, items: [], signals: 0 },
    watchlist: [],
    news: { hidden: false, items: [] },
    review: null,
    attentionCount: null,
  };
}

const pick = (over: Partial<HomePick> = {}): HomePick => ({
  profile: "balanced",
  rank: 1,
  stock: "Zed Upward Holdings",
  family: "F1",
  tier: "U1",
  label: "UNVALIDATED",
  referenceMicro: 10_000_000,
  stopMicro: 9_200_000,
  aimMicro: 11_000_000,
  aimReachPpm: null,
  timeFrameSessions: 4,
  validUntil: "2026-10-23",
  whyHref: "/picks/p1",
  ...over,
});

const tile = (over: Partial<StrategyTile> = {}): StrategyTile => ({
  id: "E01",
  name: "Follow the trend",
  seed: m(600_000_000),
  value: m(612_000_000),
  sinceStart: m(12_000_000),
  sinceStartPpm: 20_000,
  dayChange: m(3_000_000),
  dayChangePpm: 5_000,
  startD: "2026-10-19",
  ...over,
});

function show(
  patch: (v: HomeView) => void = () => {},
  o: Partial<Loaded<HomeView>> & { role?: string | null; welcome?: boolean } = {},
) {
  const data = baseView();
  patch(data);
  const { role = "owner", welcome = false, ...rest } = o;
  const result: Loaded<HomeView> = {
    state: "ok",
    asOf: "2026-10-19",
    text: "",
    masked: false,
    data,
    ...rest,
  };
  return render(<HomeContent result={result} role={role} showWelcome={welcome} />);
}

describe("moodOf", () => {
  it("has no mood before a regime is stored, and keeps an unknown regime's own word", () => {
    expect(moodOf(null)).toEqual({ key: "neutral", word: "Not measured yet" });
    const odd = moodOf("SIDEWAYS");
    expect(odd.key).toBe("neutral");
    expect(odd.word).not.toContain(":");
  });
});

describe("daySentence", () => {
  const withPpm = (ppm: number | null, label: string | null, total = 0) => {
    const v = baseView();
    v.picksTotal = total;
    v.headline = [{ currency: "AUD", sinceStartPpm: 0, dayChangePpm: ppm, series: [] }];
    v.dayLabel = label;
    return daySentence(v);
  };
  it("counts picks from the total, else from the list, singular and plural", () => {
    expect(withPpm(null, null, 1)).toBe("1 pick on the list for the next session.");
    const v = baseView();
    v.picks.items = [pick(), pick({ rank: 2 })];
    expect(daySentence(v)).toBe("2 picks on the list for the next session.");
  });
  it("says unchanged, today or on a named day, up or down", () => {
    expect(withPpm(0, "Today", 2)).toContain("Your strategies are unchanged today.");
    expect(withPpm(0, null, 2)).toContain("unchanged today.");
    expect(withPpm(20_000, "Mon 19 Oct", 2)).toContain("up 2.00% on Mon 19 Oct.");
    expect(withPpm(-20_000, "Today (delayed, 10:45)", 2)).toContain("down 2.00% today (delayed).");
  });
  it("says nothing about the strategies when the change is not measured", () => {
    expect(withPpm(null, "Today", 2)).not.toContain("Your strategies");
  });
});

describe("Home content: failure, empty and stale", () => {
  it("shows the danger banner and the welcome banner when the loader failed", () => {
    render(<HomeContent result={null} role="owner" showWelcome />);
    expect(screen.getByText("Could not load Home")).toBeInTheDocument();
    expect(screen.getByText(/The menus\s+still work/)).toBeInTheDocument();
    cleanup();
    render(<HomeContent result={null} role="owner" showWelcome={false} />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.queryByTestId("how-it-works")).toBeNull();
  });

  it("explains an empty world and every empty section in words", () => {
    show(() => {}, { state: "empty", asOf: null, text: "Nothing has run yet." });
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(document.querySelector("[data-summary]")!.textContent).toBe("Nothing has run yet.");
    expect(screen.getByText(/Changes since the last session appear here/)).toBeInTheDocument();
    expect(screen.getByText(/No picks yet. The first ones come after tonight/)).toBeInTheDocument();
    expect(screen.getByText(/No strategy is running yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing starred yet/)).toBeInTheDocument();
    expect(screen.getByText(/No news yet/)).toBeInTheDocument();
    expect(screen.getByText(/first Evening Review appears after/)).toBeInTheDocument();
    expect(screen.getByText("No run yet")).toBeInTheDocument();
    expect(screen.getAllByText(/Not measured yet/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Needs you")).toBeNull();
    expect(screen.getByTestId("how-it-works")).toBeInTheDocument();
  });

  it("shows the stale banner text", () => {
    show(() => {}, { state: "stale", text: "Showing data from Fri 16 Oct." });
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.getByText("Showing data from Fri 16 Oct.")).toBeInTheDocument();
  });
});

describe("Home content: status strip", () => {
  it("shows a gain with an arrow, the day change and the end-of-day index close", () => {
    show((v) => {
      v.headline = [
        {
          currency: "AUD",
          sinceStartPpm: 25_000,
          dayChangePpm: 4_000,
          series: [0, 10_000, 25_000],
        },
      ];
      v.dayLabel = "Fri 16 Oct";
      v.dataAtLabel = "End of day, Fri 16 Oct";
      v.day.regime = "RISK-ON";
      v.day.index = {
        name: "ASX 200",
        level: 8123.456,
        changePpm: 3_000,
        at: null,
        d: "2026-10-16",
      };
      v.dataOnly = true;
    });
    const strip = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip.querySelector("[data-outcome=positive]")!.textContent).toContain("▲");
    expect(strip.textContent).toContain("Fri 16 Oct +0.40%");
    expect(strip.textContent).toContain("8,123.5");
    expect(strip.textContent).toContain("close Fri 16 Oct");
    expect(strip.textContent).toContain("End of day, Fri 16 Oct");
    expect(screen.getByTestId("data-only-line")).toHaveTextContent(
      "Data only: prices and news, no trading yet",
    );
    expect(strip.textContent).not.toMatch(ISO);
  });

  it("shows a loss and a delayed falling index during the session", () => {
    show((v) => {
      v.headline = [{ currency: "AUD", sinceStartPpm: -15_000, dayChangePpm: null, series: [] }];
      v.day.regime = "RISK-OFF";
      v.day.index = {
        name: "ASX 200",
        level: 8000,
        changePpm: -2_000,
        at: "11:35",
        d: "2026-10-19",
      };
    });
    const strip = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip.querySelector("[data-outcome=negative]")).not.toBeNull();
    expect(strip.textContent).toContain("▼");
    expect(strip.textContent).toContain("delayed, 11:35");
    expect(strip.textContent).toContain("Prices");
    expect(strip.textContent).toContain("Mon 19 Oct");
  });

  it("shows no change as flat, and an index with no change or date as a bare level", () => {
    show((v) => {
      v.headline = [{ currency: "AUD", sinceStartPpm: 0, dayChangePpm: 0, series: [] }];
      v.day.index = { name: "ASX 200", level: 8000, changePpm: 0, at: null, d: null };
    });
    const strip = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip.querySelectorAll("[data-outcome=outcome-flat]").length).toBe(2);
    cleanup();
    show((v) => {
      v.day.index = { name: "ASX 200", level: 8000, changePpm: null, at: null, d: null };
    });
    const strip2 = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip2.textContent).toContain("8,000.0");
    expect(strip2.textContent).not.toMatch(/close|delayed/);
  });
});

describe("Home content: since yesterday and needs you", () => {
  it("lists change rows as links, and needs with their tier word", () => {
    show((v) => {
      v.since = [
        { key: "picks", text: "3 new picks", href: "/picks" },
        { key: "breakers", text: "1 warning sign", href: "/risk" },
      ];
      v.needs = [
        { key: "a", tier: "P0", text: "Urgent thing", href: "/alerts/1", action: "Open it" },
        { key: "b", tier: "P1", text: "Important thing", href: "/alerts/2", action: "Review" },
        { key: "c", tier: "P2", text: "Just so you know", href: "/alerts/3", action: "See" },
      ];
    });
    expect(screen.getByRole("link", { name: /3 new picks/ })).toHaveAttribute("href", "/picks");
    const needs = document.getElementById("home-needs")!;
    expect(within(needs).getByText("Urgent")).toBeInTheDocument();
    expect(within(needs).getByText("Important")).toBeInTheDocument();
    expect(within(needs).getByText("FYI")).toBeInTheDocument();
    expect(within(needs).getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/alerts/1",
    );
  });
});

describe("Home content: My portfolio (D-950)", () => {
  it("shows the three practice portfolios once one has started, nothing before", () => {
    show();
    expect(screen.queryByTestId("pick-portfolio")).toBeNull();
    cleanup();
    show((v) => {
      v.portfolios = {
        masked: false,
        seed: m(1_000_000_000),
        stockMaxPct: 30,
        strategyMaxPct: 40,
        portfolios: ["conservative", "balanced", "aggressive"].map((profile) => ({
          profile,
          started: profile === "balanced",
          holdingsMax: 4,
          asOfD: null,
          seed: null,
          value: null,
          cash: null,
          gain: null,
          sinceStartPpm: null,
          worstFallPpm: null,
          holdings: [],
          split: null,
          splitWhy: null,
          trades: [],
          closed: 0,
          wins: 0,
        })),
      } as unknown as HomeView["portfolios"];
    });
    expect(screen.getByTestId("pick-portfolio")).toHaveTextContent("My portfolio");
    expect(screen.getAllByText("Starts with the first pick.")).toHaveLength(2);
  });
});

describe("Home content: picks", () => {
  it("shows the top pick of a profile with prices, size word, time frame and plain valid-until day", () => {
    show((v) => {
      v.picks.items = [pick(), pick({ profile: "aggressive", rank: 2, tier: "U9" })];
    });
    const cards = document.querySelectorAll("[data-pick-card]");
    expect(cards).toHaveLength(1);
    const t = cards[0]!.textContent!;
    expect(t).toContain("Balanced #1");
    expect(t).toContain("Large company");
    expect(t).toContain("Time frame 4 sessions");
    expect(t).toContain("Valid until Fri 23 Oct");
    expect(t).not.toMatch(ISO);
    expect(screen.getByRole("link", { name: "Why this pick" })).toHaveAttribute(
      "href",
      "/picks/p1",
    );
  });

  it("falls back to the first three in list order, singular session, unknown profile and size, missing prices", () => {
    show((v) => {
      v.picks.items = [
        pick({
          profile: "custom",
          rank: 2,
          tier: "U9",
          timeFrameSessions: 1,
          validUntil: null,
          aimMicro: null,
          stopMicro: null,
        }),
        pick({ rank: 3, timeFrameSessions: null }),
        pick({ rank: 4 }),
        pick({ rank: 5 }),
      ];
    });
    const cards = document.querySelectorAll("[data-pick-card]");
    expect(cards).toHaveLength(3);
    expect(cards[0]!.textContent).toContain("custom #2");
    expect(cards[0]!.textContent).toContain("Time frame 1 session");
    expect(cards[0]!.textContent).not.toContain("company");
    expect(cards[0]!.textContent).not.toContain("Valid until");
    expect(cards[0]!.textContent).toContain("Aim n/a");
    expect(cards[0]!.textContent).toContain("Stop n/a");
    expect(cards[1]!.textContent).toContain("Time frame not set");
  });

  it("hides prices for a masked viewer and says so, and says nothing for an unmasked pick without prices", () => {
    show(
      (v) => {
        v.picks.items = [
          pick({ referenceMicro: null, stock: "Stock A", validUntil: "week 2026-W43" }),
        ];
      },
      { masked: true, role: "viewer" },
    );
    const card = document.querySelector("[data-pick-card]")!;
    expect(card.textContent).toContain("Prices hidden for your role");
    expect(card.textContent).toContain("Valid until week 2026-W43");
    cleanup();
    show((v) => {
      v.picks.items = [pick({ referenceMicro: null })];
    });
    expect(document.querySelector("[data-pick-card]")!.textContent).not.toMatch(/Aim|Stop|hidden/);
  });
});

describe("Home content: strategy tiles", () => {
  it("shows the day change with and without a percentage, and the end-of-day footer", () => {
    show((v) => {
      v.dayLabel = "Fri 16 Oct";
      v.summary = {
        strategies: 2,
        d: "2026-10-16",
        tiles: [
          tile(),
          tile({ id: "E02", name: "Buy the dip", sinceStartPpm: null, dayChangePpm: null }),
          tile({ id: "E03", name: "Steady", dayChange: null }),
        ],
      };
    });
    const first = document.querySelector("[data-strategy-tile=E01]")!.textContent!;
    expect(first).toContain("Fri 16 Oct:");
    expect(first).toContain("(+0.50%)");
    expect(first).toContain("(+2.00%)");
    const second = document.querySelector("[data-strategy-tile=E02]")!.textContent!;
    expect(second).not.toContain("%");
    expect(document.querySelector("[data-strategy-tile=E03]")!.textContent).not.toContain(
      "Fri 16 Oct:",
    );
    expect(screen.getByText(/End of day, Fri 16 Oct\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Follow the trend" })).toHaveAttribute(
      "href",
      "/strategies/E01",
    );
    expect(document.body.textContent).not.toMatch(ISO);
  });

  it("says values move with delayed prices while the session runs, with Today as the day label", () => {
    show((v) => {
      v.dayLabel = "Today (delayed, 10:45)";
      v.summary = { strategies: 1, d: "2026-10-19", tiles: [tile()] };
    });
    expect(
      screen.getByText(/Values move with delayed prices during the session\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/End of day,/)).toBeNull();
    cleanup();
    show((v) => {
      v.dayLabel = null;
      v.summary = { strategies: 1, d: null, tiles: [tile()] };
    });
    expect(document.querySelector("[data-strategy-tile=E01]")!.textContent).toContain("Today:");
    expect(screen.queryByText(/End of day,/)).toBeNull();
  });
});

describe("Home content: watchlist, news and review", () => {
  it("shows the watchlist to an Owner with delayed and end-of-day prices, and hides it from a viewer", () => {
    show((v) => {
      v.watchlist = [
        { stock: "ZZUP", close: 10.5, changePpm: 12_000, at: "11:35" },
        { stock: "ZZDN", close: 4.2, changePpm: null, at: null },
        { stock: "ZZOTH", close: null, changePpm: null, at: null },
      ];
    });
    const wl = document.getElementById("home-watchlist")!;
    expect(wl.textContent).toContain("10.50 (delayed, 11:35)");
    expect(wl.textContent).toContain("End-of-day 4.20");
    expect(wl.textContent).toContain("Not measured yet");
    cleanup();
    show(() => {}, { role: "viewer", masked: true });
    expect(document.getElementById("home-watchlist")).toBeNull();
  });

  it("hides a masked editor's prices in the watchlist", () => {
    show(
      (v) => {
        v.watchlist = [{ stock: "Stock A", close: null, changePpm: 5_000, at: null }];
      },
      { role: "editor", masked: true },
    );
    expect(document.getElementById("home-watchlist")!.textContent).toContain("Price hidden");
  });

  it("links news to the company for the Owner, shows plain lines when masked, and says when it is hidden", () => {
    const items = [{ stock: "ZZUP", title: "Half year results", publishedAt: "x", materiality: 2 }];
    show((v) => {
      v.news = { hidden: false, items };
    });
    expect(screen.getByRole("link", { name: /ZZUP — Half year results/ })).toHaveAttribute(
      "href",
      "/market/ZZUP",
    );
    cleanup();
    show(
      (v) => {
        v.news = { hidden: false, items };
      },
      { masked: true },
    );
    expect(screen.getByText(/Half year results/).closest("a")).toBeNull();
    cleanup();
    show((v) => {
      v.news = { hidden: true, items: [] };
    });
    expect(screen.getByText("Company news is hidden for your role.")).toBeInTheDocument();
  });

  it("links the latest review by its date for the Owner, by the list for a masked viewer", () => {
    show((v) => {
      v.review = { d: "2026-10-19", day: "2026-10-19", kind: "evening" };
    });
    const link = screen.getByRole("link", { name: /Latest Evening Review, Mon 19 Oct/ });
    expect(link).toHaveAttribute("href", "/reviews/2026-10-19");
    cleanup();
    show(
      (v) => {
        v.review = { d: "2026-10-19", day: null, kind: "evening" };
      },
      { masked: true },
    );
    const masked = screen.getByRole("link", { name: "Latest Evening Review" });
    expect(masked).toHaveAttribute("href", "/reviews");
    cleanup();
    show((v) => {
      v.review = { d: "2026-W43", day: "2026-W43", kind: "evening" };
    });
    expect(screen.getByRole("link", { name: /, 2026-W43/ })).toBeInTheDocument();
  });
});
