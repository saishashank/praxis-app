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
  it("shows the 12 strategies, the A$1,200 goal, the A$300 loss line and Simulated, with a dismiss button", async () => {
    await view(empty, VIEWER, true);
    const w = screen.getByRole("region", { name: "Welcome to Praxis" });
    expect(w).toHaveTextContent(/Twelve/);
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
