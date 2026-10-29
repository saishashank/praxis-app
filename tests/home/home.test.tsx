// M7 T11 Home (AT-25 rows for Home, AT-27 honesty, UX-012a welcome banner, UX-009 masking, empty / stale /
// error states): the real Home loader over the seeded test databases, rendered by the real component.
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { loadHome } from "@/lib/ui/loaders/home";
import { HomeContent, daySentence } from "@/app/(app)/home/HomeContent";
import { welcomeCookieName } from "@/app/(app)/home/welcome";
import {
  CODES,
  deps,
  EDITOR,
  emptyDbs,
  LATE,
  NOW,
  leaks,
  NAMES,
  OWNER,
  seedPopulated,
  VIEWER,
  type Both,
} from "../loaders/seed";

vi.mock("@/app/(app)/home/actions", () => ({ dismissWelcomeAction: vi.fn() }));

afterEach(cleanup);
afterAll(cleanupTempDbs);

let pop: Both;
let empty: Both;
beforeAll(async () => {
  pop = await emptyDbs();
  await seedPopulated(pop);
  empty = await emptyDbs();
});

async function view(db: Both, u: { id: number; role: string } | null, welcome = false, now?: Date) {
  const result = await loadHome(deps(db, u, now));
  const r = render(<HomeContent result={result} role={u?.role ?? null} showWelcome={welcome} />);
  return { result, ...r };
}

async function axeViolations(container: HTMLElement) {
  const r = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return r.violations.map((v) => v.id);
}

describe("Home page content", () => {
  it("Owner: heading, summary with Simulated label, picks, ideas, watchlist, review link", async () => {
    const { result } = await view(pop, OWNER);
    expect(result.masked).toBe(false);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByText("Strategies today")).toBeInTheDocument();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
    expect(screen.getByText("Today's picks")).toBeInTheDocument();
    expect(screen.getByText("Tonight's trade ideas")).toBeInTheDocument();
    expect(screen.getByText("Your watchlist")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all tonight's ideas" })).toHaveAttribute(
      "href",
      "/strategies/ideas",
    );
    expect(screen.getByRole("link", { name: /Latest Evening Review/ })).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/reviews\/\d{4}-\d{2}-\d{2}$/),
    );
    // the Owner sees real codes
    expect(document.body.textContent).toContain(CODES[0]);
  });

  it("every money value sits in a card that also carries the Simulated label (AT-27)", async () => {
    await view(pop, OWNER);
    const money = document.querySelectorAll("[data-money]");
    expect(money.length).toBeGreaterThan(0);
    for (const el of money) {
      const card = el.closest("section");
      expect(card?.textContent, el.textContent ?? "").toMatch(/Simulated/);
    }
  });

  it("no control can place an order (AT-27)", async () => {
    await view(pop, OWNER);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\b(buy now|sell now|place (an )?order)\b/i);
    expect(screen.queryByRole("button", { name: /buy|sell|order/i })).toBeNull();
  });

  it.each([
    ["Editor", EDITOR],
    ["Viewer", VIEWER],
  ])("%s: no code, name, id, link or price of a stock reaches the page", async (_n, u) => {
    const { result } = await view(pop, u);
    expect(result.masked).toBe(true);
    const html = document.body.innerHTML;
    expect(leaks(html)).toEqual([]);
    for (const s of [...CODES, ...NAMES]) expect(html).not.toContain(s);
    expect(leaks(result.data)).toEqual([]);
    expect(screen.getByText("Company news is hidden for your role.")).toBeInTheDocument();
    // the review link goes to the list, so no exact date is exposed
    expect(screen.getByRole("link", { name: /Latest Evening Review/ })).toHaveAttribute(
      "href",
      "/reviews",
    );
    expect(document.body.textContent).not.toMatch(/Valid until \d{4}-\d{2}-\d{2}/);
  });

  it("Viewer has no watchlist section; Editor does", async () => {
    await view(pop, VIEWER);
    expect(screen.queryByText("Your watchlist")).toBeNull();
    cleanup();
    await view(pop, EDITOR);
    expect(screen.getByText("Your watchlist")).toBeInTheDocument();
  });

  it("Owner status line names the attention count; others only link to System health", async () => {
    await view(pop, OWNER);
    expect(screen.getByTestId("status-line").textContent).toMatch(
      /All systems working|need a look/,
    );
    cleanup();
    await view(pop, EDITOR);
    expect(screen.getByTestId("status-line").textContent).toBe("System health");
  });
});

describe("states", () => {
  it("empty: honest placeholders, no sample numbers, nothing hidden", async () => {
    const { result } = await view(empty, OWNER);
    expect(result.state).toBe("empty");
    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.getByText(/First Evening Review at 20:00/)).toBeInTheDocument();
    expect(screen.getAllByText(/No trade ideas yet/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/SAMPLE DATA/)).toBeNull();
    expect(document.querySelectorAll("[data-money]")).toHaveLength(0);
    expect(screen.getByText("No strategy is running yet.")).toBeInTheDocument();
  });

  it("stale: banner with the last good date", async () => {
    const { result } = await view(pop, OWNER, false, LATE);
    expect(result.state).toBe("stale");
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Out of date");
    expect(banner).toHaveTextContent(result.asOf!);
  });

  it("error: the loader failed -> a clear message, no crash", () => {
    render(<HomeContent result={null} role="viewer" showWelcome={false} />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Home");
  });
});

describe("welcome banner (UX-012a)", () => {
  it("shows the six strategies (D-191), the A$1,200 goal, the A$300 loss line and Simulated, with a dismiss button", async () => {
    await view(empty, VIEWER, true);
    const w = screen.getByRole("region", { name: "Welcome to Praxis" });
    expect(w).toHaveTextContent(/Six practice strategies/);
    expect(w).toHaveTextContent("A$1,200");
    expect(w).toHaveTextContent("A$300");
    expect(w).toHaveTextContent(/Simulated/);
    expect(within(w).getByRole("button", { name: "Got it, hide this" })).toBeInTheDocument();
  });

  it("is absent once dismissed", async () => {
    await view(pop, OWNER, false);
    expect(screen.queryByText("Welcome to Praxis")).toBeNull();
  });

  it("the cookie name is per user", () => {
    expect(welcomeCookieName(1)).not.toBe(welcomeCookieName(2));
    expect(welcomeCookieName(7)).not.toMatch(/[^\w-]/);
  });
});

describe("accessibility and layout", () => {
  it.each([
    ["Owner", OWNER],
    ["Viewer", VIEWER],
  ])("%s: axe finds no violations (populated, welcome shown)", async (_n, u) => {
    const { container } = await view(pop, u, true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("empty state has no axe violations", async () => {
    const { container } = await view(empty, EDITOR, true);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("sections can shrink: every card is min-w-0 and long words wrap", async () => {
    await view(pop, OWNER);
    for (const s of document.querySelectorAll("section")) {
      expect(s.className).toMatch(/min-w-0/);
      expect(s.className).toMatch(/break-words/);
    }
  });

  it("the day sentence never names a stock", async () => {
    const result = await loadHome(deps(pop, OWNER));
    expect(daySentence(result.data)).not.toMatch(new RegExp(CODES.join("|")));
  });
});

describe("Home for a first-time user (D-200)", () => {
  const tile = {
    id: "E01",
    name: "Follow the trend",
    seed: { micro: "600000000", currency: "AUD", simulated: true },
    value: { micro: "600000000", currency: "AUD", simulated: true },
    startD: "2026-10-19",
    sinceStart: { micro: "0", currency: "AUD", simulated: true },
    sinceStartPpm: 0,
    dayChange: null,
  };
  const news = { stock: "ZZUP", title: "Half year results", publishedAt: "x", materiality: 2 };

  async function withView(u: typeof OWNER, patch: (v: Record<string, unknown>) => void) {
    const result = await loadHome(deps(pop, u));
    const data = structuredClone(result.data) as unknown as Record<string, unknown>;
    patch(data);
    render(
      <HomeContent
        result={{ ...result, data: data as unknown as typeof result.data }}
        role={u.role}
        showWelcome={false}
      />,
    );
  }

  it("says the data checks in one sentence, opens a strategy from its tile and a company from news", async () => {
    await withView(OWNER, (v) => {
      v.day = {
        regime: null,
        regimeD: null,
        quality: [{ tier: "U1", score: 1, gatePass: true }],
        openFlags: 7,
      };
      (v.summary as { tiles: unknown[] }).tiles = [tile];
      v.news = { hidden: false, items: [news] };
    });
    expect(document.body.textContent).not.toMatch(/Data U1|data flags? still open/);
    expect(screen.getByRole("link", { name: "Follow the trend" })).toHaveAttribute(
      "href",
      "/strategies/E01",
    );
    expect(screen.getByRole("link", { name: /ZZUP — Half year results/ })).toHaveAttribute(
      "href",
      "/market/ZZUP",
    );
  });

  it("says when prices are still being checked, and a masked user's news is not a link", async () => {
    await withView(EDITOR, (v) => {
      v.day = {
        regime: null,
        regimeD: null,
        quality: [
          { tier: "U1", score: 1, gatePass: true },
          { tier: "U2", score: 0, gatePass: false },
        ],
        openFlags: 0,
      };
      v.news = { hidden: false, items: [{ ...news, stock: "Stock A" }] };
    });
    expect(screen.getByText(/Half year results/).closest("a")).toBeNull();
  });
});

describe("Home redesign (UXR-020, 044, 053, 055, 056)", () => {
  async function withPatch(u: typeof OWNER, patch: (v: Record<string, unknown>) => void) {
    const result = await loadHome(deps(pop, u));
    const data = structuredClone(result.data) as unknown as Record<string, unknown>;
    patch(data);
    return render(
      <HomeContent
        result={{ ...result, data: data as unknown as typeof result.data }}
        role={u.role}
        showWelcome={false}
      />,
    );
  }

  it.each([
    ["RISK-ON", "on", "Risk-on"],
    ["NEUTRAL", "neutral", "Neutral"],
    ["RISK-OFF", "off", "Risk-off"],
    ["SHOCK", "off", "Shock"],
  ])("status strip: %s -> %s gradient and the word %s", async (regime, key, word) => {
    await withPatch(OWNER, (v) => {
      (v.day as { regime: string }).regime = regime;
    });
    const strip = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip).toHaveAttribute("data-mood", key);
    expect(strip.getAttribute("style")).toContain(`--gradient-mood-${key}`);
    expect(strip).toHaveTextContent(word);
  });

  it("status strip shows the freshness and the next run, in outcome colour with a sparkline", async () => {
    await view(pop, OWNER, false, NOW);
    const strip = screen.getByRole("region", { name: "Today at a glance" });
    expect(strip).toHaveTextContent("Data as of");
    expect(strip).toHaveTextContent(/Next run\s*(tonight|tomorrow|[A-Z][a-z]{2}) 18:10/);
    expect(strip.querySelector("[data-outcome]")).not.toBeNull();
    expect(strip.querySelector("[data-sparkline]")).not.toBeNull();
    // the number carries a sign glyph and words, never colour alone
    expect(strip.textContent).toMatch(/[▲▼–]/);
  });

  it("data-only mode adds one line in the strip, and only there", async () => {
    await withPatch(OWNER, (v) => {
      v.dataOnly = true;
    });
    const line = screen.getAllByTestId("data-only-line");
    expect(line).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Today at a glance" })).toContainElement(line[0]!);
    cleanup();
    await withPatch(OWNER, (v) => {
      v.dataOnly = false;
    });
    expect(screen.queryByTestId("data-only-line")).toBeNull();
  });

  it("every empty section says what appears and when (UXR-007) and shows an illustration", async () => {
    await view(empty, OWNER);
    const blocks = document.querySelectorAll("[data-empty]");
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const b of blocks) {
      expect(b.textContent ?? "", b.textContent ?? "").toMatch(
        /after |at \d\d:\d\d|as soon as|as they are|from the next|appear/i,
      );
      expect(b.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("Since yesterday rows are single links; Needs you has an empty state", async () => {
    await view(pop, OWNER);
    const since = screen.getByRole("region", { name: "Since yesterday" });
    const rows = within(since).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const r of rows) expect(within(r).getAllByRole("link")).toHaveLength(1);
    expect(within(since).getByRole("link", { name: /pick/ })).toHaveAttribute("href", "/picks");
  });

  it("Needs you: tier-coloured items with one action each", async () => {
    await withPatch(OWNER, (v) => {
      v.needs = [
        {
          key: "a",
          tier: "P0",
          text: "Halt on a held stock",
          href: "/news?chip=alerts",
          action: "Open alert",
        },
        {
          key: "b",
          tier: "P1",
          text: "Two things need a look",
          href: "/health",
          action: "Open System Health",
        },
      ];
    });
    const needs = screen.getByRole("region", { name: "Needs you" });
    const items = within(needs).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector("[data-hue='tier-p0']")).not.toBeNull();
    expect(items[1]!.querySelector("[data-hue='tier-p1']")).not.toBeNull();
    for (const i of items) expect(within(i).getAllByRole("link")).toHaveLength(1);
  });

  it("pick cards show the family badge text, aim, stop, time frame and Why this pick", async () => {
    await view(pop, OWNER);
    const cards = document.querySelectorAll("[data-pick-card]");
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(3);
    for (const c of cards) {
      const badge = c.querySelector("[data-family]");
      expect(badge, c.textContent ?? "").not.toBeNull();
      expect(badge!.textContent).toMatch(/^(BR|VC|ND|BO|SC|CO|EX)\s?\S/);
      expect(c.textContent).toMatch(/Aim .*Stop /);
      expect(c.textContent).toMatch(/Time frame/);
      expect(within(c as HTMLElement).getByRole("link", { name: "Why this pick" })).toBeTruthy();
    }
  });

  it.each([
    ["Editor", EDITOR],
    ["Viewer", VIEWER],
  ])("%s: pick cards keep the family badge but no code, price or exact date", async (_n, u) => {
    await view(pop, u);
    const cards = document.querySelectorAll("[data-pick-card]");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.querySelector("[data-family]")).not.toBeNull();
      expect(c.querySelector("[data-money]")).toBeNull();
      expect(c.textContent).not.toMatch(/Valid until \d{4}-\d{2}-\d{2}/);
    }
    const html = document.body.innerHTML;
    for (const s of [...CODES, ...NAMES]) expect(html).not.toContain(s);
    expect(leaks(html)).toEqual([]);
  });

  it("welcome: full card once, then a one-line 'how Praxis works' row", async () => {
    await view(pop, OWNER, true);
    expect(screen.getByText("Welcome to Praxis")).toBeInTheDocument();
    expect(screen.queryByTestId("how-it-works")).toBeNull();
    cleanup();
    await view(pop, OWNER, false);
    expect(screen.queryByText("Welcome to Praxis")).toBeNull();
    expect(screen.getByRole("link", { name: "Read how Praxis works" })).toBeInTheDocument();
  });

  it("the counter renders its final value and an accessible label without any animation", async () => {
    await view(pop, OWNER);
    const c = document.querySelector("[data-countup]");
    expect(c).not.toBeNull();
    expect(c!.querySelector(".sr-only")?.textContent).toMatch(/(gain|loss|no change):/);
  });
});

describe("Home loader additions", () => {
  it("the system row says in one sentence whether the prices passed their checks (D-200)", async () => {
    const r = await loadHome(deps(pop, EDITOR));
    const sys = r.data.since.find((x) => x.key === "system");
    expect(sys?.href).toBe("/health");
    expect(sys?.text).toMatch(/passed their checks|still being checked|have not run/);
    expect(JSON.stringify(r.data.since)).not.toMatch(/Data U1|data flags? still open/);
    expect(r.data.since.length).toBeLessThanOrEqual(5);
  });

  it("next run label skips the weekend and melbourneStamp reads Melbourne time", async () => {
    const { nextRunLabel, melbourneStamp } = await import("@/lib/ui/loaders/home");
    // Tue 21 Oct 2026 14:00 Melbourne (03:00Z): before the slot
    expect(nextRunLabel(new Date("2026-10-21T03:00:00Z"))).toBe("tonight 18:10");
    // 19:00 Melbourne (08:00Z) the same day
    expect(nextRunLabel(new Date("2026-10-21T08:00:00Z"))).toBe("tomorrow 18:10");
    // Fri 19:00 Melbourne -> Mon
    expect(nextRunLabel(new Date("2026-10-23T08:00:00Z"))).toBe("Mon 18:10");
    expect(melbourneStamp("2026-10-21T05:45:00Z")).toBe("Wed 21 Oct, 16:45");
    expect(melbourneStamp(null)).toBeNull();
  });
});
