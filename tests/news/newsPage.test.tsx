// M7 T16 News and alert inbox (UX-060..062; UXN-035, 038, 157, 158, 160, 161; AT-25 masking, AT-26 a11y).
// The page is rendered from a real (temporary) database through the page component for every role.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import {
  CODES,
  D,
  emptyWorld,
  envOf,
  fullWorld,
  NAMES,
  type Who,
  type World,
} from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import NewsPage from "@/app/(app)/news/page";
import { findLeaks } from "@/lib/view/mask";

let current: LoaderEnv;
const replace = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => ({ id: 1, role: "owner" })) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ replace, refresh }),
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

afterAll(cleanupTempDbs);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  replace.mockClear();
  refresh.mockClear();
});

const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const as = (w: World, who: Who) => {
  current = envOf(w, who);
};
const ALL: Who[] = ["owner", "editor", "viewer", "granted"];
const MASKED: Who[] = ["editor", "viewer"];

async function addAlert(
  w: World,
  key: string,
  kind: string,
  tier: string,
  code: string | null,
  facts: object,
  at = `${D}T02:04:00.000Z`,
) {
  await w.main.execute({
    sql: "INSERT INTO alert (alert_key, market, code, kind, tier, detected_at, facts_json) VALUES (?, 'AU', ?, ?, ?, ?, ?)",
    args: [key, code, kind, tier, at, JSON.stringify(facts)],
  });
}

let w: World;
// The Acknowledge button of the urgent alert (its "why" line mentions the halt).
const p0Ack = () =>
  within(
    screen.getAllByTestId("alert-item").find((i) => i.textContent?.includes("Trading halt on"))!,
  ).getByRole("button", { name: /^Acknowledge/ });
// AlertActions is a lazy chunk (bundle budget): wait until the inbox buttons have loaded.
const actionsLoaded = () =>
  screen.findAllByRole("button", { name: /^(Acknowledge|Snooze|Clear snooze)/ });
beforeAll(async () => {
  w = await fullWorld();
  await addAlert(w, "ann:AU:src:n9", "announcement", "P0", "ZZUP", {
    rule: "r",
    why: "Trading halt on ZZUP",
    executions: [{ id: "E01", label: "F1 U", weightPct: 5 }],
  });
  await addAlert(w, "tb:AU:ZZUP:2026-10-19", "thesis_breaker", "P2", "ZZUP", {
    rule: "r",
    why: "A breaker on ZZUP turned red",
    executions: [],
  });
  await addAlert(w, "regime:AU:2026-10-19", "regime_shift", "P1", null, {
    rule: "r",
    why: "Market mood changed",
    executions: [],
  });
  await addAlert(w, "ann:AU:src:n8", "announcement", "P2", "ZZUP", {
    rule: "r",
    why: "An old note",
    executions: [],
  });
  for (const id of [w.ids.owner, w.ids.editor, w.ids.viewer, w.ids.granted]) {
    await w.auth.execute({
      sql: "INSERT INTO alert_user_state (user_id, alert_key, acked_at, snoozed_until, updated_at) VALUES (?, 'ann:AU:src:n8', ?, NULL, ?)",
      args: [id, "2026-10-19T03:00:00.000Z", "2026-10-19T03:00:00.000Z"],
    });
  }
  // The owner snoozed the important announcement alert.
  await w.auth.execute({
    sql: "INSERT INTO alert_user_state (user_id, alert_key, acked_at, snoozed_until, updated_at) VALUES (?, 'ann:AU:src:n1', NULL, '2026-10-21T00:00:00.000Z', '2026-10-19T03:00:00.000Z')",
    args: [w.ids.owner],
  });
});

describe("News chips and cards (UXN-035, UXN-158)", () => {
  it("shows the three chips, All news first and the default (Owner 2026-10-27)", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp() }));
    expect(screen.getByRole("heading", { level: 1, name: "News" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "News view" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "All news (Selected)",
      "My companies",
      expect.stringMatching(/^Alerts/),
    ]);
    // UXR-002 cues: check icon, filled surface and aria-current on the selected segment only
    expect(links[0]!.querySelector("svg")).not.toBeNull();
    expect(links[0]!.className).toContain("bg-accent");
    expect(links[1]!.querySelector("svg")).toBeNull();
    expect(links[1]).not.toHaveAttribute("aria-current");
    expect(links[0]).toHaveAttribute("aria-current", "page");
    expect(links[0]).toHaveAttribute("href", "/news");
    const cards = screen.getAllByTestId("news-card");
    expect(cards).toHaveLength(2);
    // the headline comes first, then who (company name and code) and when
    const first = cards[0]!.textContent ?? "";
    const title = within(cards[0]!).getAllByRole("button")[0]!.textContent ?? "";
    expect(first.startsWith(title)).toBe(true);
    expect(first).toContain("ResultsZed Other Group (ZZOTH)·");
  });

  it("My companies lists held or watched items", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "mine" }) }));
    const cards = screen.getAllByTestId("news-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("ZZUP");
    expect(within(cards[0]!).getByTestId("held-tag").textContent).toBe("Held by our strategies");
  });

  it("labels the polarity tag as rule-based, with a how-we-decided control (never a bare sentiment)", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
    const tags = screen.getAllByTestId("polarity-tag");
    expect(tags.length).toBe(2);
    for (const t of tags) {
      expect(t.textContent).toMatch(/for our trades · rule-based/);
      expect(within(t).getByRole("button", { name: "How this tag was decided" })).toBeVisible();
    }
    expect(screen.queryByText(/bullish|bearish/i)).toBeNull();
  });

  it("filters by code, text and dates, and shows the empty state when nothing matches", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "all", code: "zzoth" }) }));
    expect(screen.getAllByTestId("news-card")).toHaveLength(1);
    cleanup();
    render(await NewsPage({ searchParams: sp({ chip: "all", q: "halt" }) }));
    expect(screen.getAllByTestId("news-card")[0]!.textContent).toContain("trading halt");
    cleanup();
    render(await NewsPage({ searchParams: sp({ chip: "all", from: "2026-10-20" }) }));
    expect(screen.getByText("No news yet")).toBeInTheDocument();
    expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();
  });

  it("refuses a bad query with a 404", async () => {
    as(w, "owner");
    for (const bad of [{ chip: "x" }, { code: "a-b" }, { tier: "P9", chip: "alerts" }] as Array<
      Record<string, string>
    >) {
      await expect(NewsPage({ searchParams: sp(bad) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("is empty and honest with no data", async () => {
    const e = await emptyWorld();
    current = envOf(e, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
    expect(screen.getByText("No news yet")).toBeInTheDocument();
    cleanup();
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    expect(screen.getByText("No alerts")).toBeInTheDocument();
  });
});

describe("masking per role (DAT-124, UX-009)", () => {
  it("masked users see only letters, ISO weeks, no names, links, search or code filters", async () => {
    for (const who of MASKED) {
      as(w, who);
      const { container } = render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
      const html = container.innerHTML;
      expect(findLeaks(html, CODES, NAMES)).toEqual([]);
      expect(html).not.toMatch(/example\.test|A\$\s?\d|2026-10-19/);
      expect(screen.getAllByTestId("news-card")).toHaveLength(1); // ZZOTH is not in the active set
      expect(screen.getAllByTestId("news-card")[0]!.textContent).toMatch(/Stock [A-Z]/);
      expect(screen.getAllByTestId("news-card")[0]!.textContent).toContain("Week 2026-W43");
      expect(screen.queryByLabelText("Company code")).toBeNull();
      // the search field stays visible but is switched off (it would reveal which codes exist)
      expect(screen.getByLabelText("Search")).toBeDisabled();
      expect(screen.queryByTestId("held-tag")).toBeNull();
      cleanup();
    }
  });

  it("a granted viewer sees what the Owner sees", async () => {
    as(w, "granted");
    render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
    expect(screen.getAllByTestId("news-card")).toHaveLength(2);
    expect(screen.getByLabelText("Company code")).toBeInTheDocument();
  });

  it("the alert inbox is masked and its code-bearing key is opaque for masked users", async () => {
    for (const who of MASKED) {
      as(w, who);
      const { container } = render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
      const html = container.innerHTML;
      expect(findLeaks(html, CODES, NAMES)).toEqual([]);
      expect(html).not.toMatch(/tb:AU|2026-10-19/);
      expect(within(screen.getByTestId("alert-inbox")).getAllByTestId("alert-item").length).toBe(5);
      cleanup();
    }
    as(w, "owner");
    const { container } = render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    expect(container.innerHTML).toContain("ZZUP");
  });

  it("an item link from a card is ignored for masked users (no oracle)", async () => {
    for (const who of MASKED) {
      as(w, who);
      render(await NewsPage({ searchParams: sp({ item: "n1" }) }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.innerHTML).not.toContain("ZZUP");
      cleanup();
    }
  });
});

describe("Alert inbox (UXN-157, UXN-160, UXN-161)", () => {
  it("P0 is always an open section at the top; P1 and P2 collapse; acknowledged go to Archived", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    const inbox = screen.getByTestId("alert-inbox");
    const p0 = within(inbox).getByRole("heading", { name: /Urgent \(P0\)/ });
    expect(p0.closest("details")).toBeNull();
    expect(p0.textContent).toContain("1 unread");
    const sections = inbox.querySelectorAll("section, details");
    expect(sections[0]!.tagName).toBe("SECTION");
    expect(within(sections[0] as HTMLElement).getAllByTestId("alert-item")).toHaveLength(1);
    for (const t of ["P1", "P2"]) {
      const d = screen.getByTestId(`tier-${t}`);
      expect(d.tagName).toBe("SECTION"); // no accordion (UXR-025)
      expect(d.textContent).toMatch(/unread/);
    }
    expect(screen.getByTestId("alert-inbox").querySelector("details")).toBeNull();
    const archived = screen.getByTestId("archived");
    expect(archived.textContent).toContain("1 acknowledged");
    expect(archived.textContent).toContain("An old note");
    expect(within(archived).queryByRole("button", { name: /Acknowledge/ })).toBeNull();
  });

  it("an empty P0 still shows its section", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts", tier: "P1" }) }));
    expect(screen.getByRole("heading", { name: /Urgent \(P0\)/ })).toBeInTheDocument();
    expect(screen.getByTestId("p0-empty")).toBeInTheDocument();
  });

  it("snoozed alerts stay listed, dimmed and marked", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    const snoozed = screen.getAllByTestId("alert-item").filter((x) => x.dataset.snoozed === "1");
    expect(snoozed).toHaveLength(1);
    expect(snoozed[0]!.textContent).toContain("Snoozed (still listed)");
    expect(within(snoozed[0]!).getByRole("button", { name: /Clear snooze/ })).toBeVisible();
  });

  it("P0 and the market-mood alert offer no snooze; others offer the three choices", async () => {
    as(w, "editor");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    const items = screen.getAllByTestId("alert-item");
    const withSnooze = items.filter((i) => within(i).queryByText("Snooze 1 hour") !== null);
    const without = items.filter(
      (i) => within(i).queryByText("This alert cannot be snoozed or silenced.") !== null,
    );
    expect(without).toHaveLength(2); // P0 + regime P1
    expect(withSnooze).toHaveLength(2); // important announcement + P2 breaker (the old note is archived)
    for (const i of withSnooze) {
      expect(within(i).getByText("Snooze 4 hours")).toBeInTheDocument();
      expect(within(i).getByText("Snooze until tomorrow")).toBeInTheDocument();
    }
  });

  it("shows which strategies hold the company and the quiet-hours line", async () => {
    as(w, "owner");
    await w.auth.execute({
      sql: 'UPDATE user_preference SET prefs_json = json_set(COALESCE(prefs_json,\'{}\'), \'$.quiet_hours\', json(\'{"start":"22:00","end":"07:00"}\')) WHERE user_id = ?',
      args: [w.ids.owner],
    });
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    expect(screen.getByTestId("held-by").textContent).toBe("Held by: F1 U");
    expect(screen.getByText(/never silenced/)).toBeInTheDocument();
  });

  it("search narrows the inbox and the chip shows the unread count", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts", q: "market mood" }) }));
    expect(screen.getAllByTestId("alert-item")).toHaveLength(1);
    cleanup();
    render(await NewsPage({ searchParams: sp({ chip: "alerts", unacked: "1" }) }));
    expect(screen.queryByText("An old note")).toBeNull();
  });
});

describe("Ack and snooze reuse the existing routes", () => {
  it("Acknowledge posts to /api/alerts/<key>/ack and refreshes", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    fireEvent.click(p0Ack());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/alerts/${encodeURIComponent("ann:AU:src:n9")}/ack`);
    expect(init.method).toBe("POST");
    vi.unstubAllGlobals();
  });

  it("a masked user acts through the opaque mk: key, never the stored key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    as(w, "viewer");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    const btn = screen
      .getAllByRole("button", { name: /^Snooze 1 hour/ })
      .find((b) => /breaker/i.test(b.getAttribute("aria-label") ?? ""))!;
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(decodeURIComponent(url)).toMatch(/^\/api\/alerts\/mk:[0-9a-f]{16}\/snooze$/);
    const until = Date.parse((JSON.parse(String(init.body)) as { until: string }).until);
    expect(until).toBeGreaterThan(Date.now());
    vi.unstubAllGlobals();
  });

  it("shows a calm error when the route refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    fireEvent.click(p0Ack());
    await waitFor(() => expect(screen.getAllByText("Could not save. Try again.").length).toBe(1));
    expect(refresh).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("News pop-up (UXN-038)", () => {
  it("?item=<ann_id> opens the sheet for an unmasked viewer; closing returns to the list", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ item: "n2" }) }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/trading halt/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Summary not written yet/)).toBeInTheDocument();
    expect(within(dialog).getByTestId("news-sheet-tag").textContent).toMatch(/rule-based/);
    const link = within(dialog).getByRole("link", { name: /Read the original/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(replace).toHaveBeenCalledWith("/news", { scroll: false });
  });

  it("Esc closes the sheet", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ item: "n1" }) }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(replace).toHaveBeenCalled();
  });

  it("an unknown item shows a notice instead of a sheet", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ item: "nope" }) }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("News item not found")).toBeInTheDocument();
  });

  it("a headline opens the same sheet from the list by fetching /api/news/<id>", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
    const id = w.annIds.up;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id,
            stock: "ZZUP",
            company: null,
            title: "Result",
            type: null,
            published: "2026-W43",
            priceSensitive: false,
            materiality: 2,
            polarity: -1,
            assessment: "We read this as bad news.",
            url: null,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(screen.getAllByRole("button", { name: /full-year result/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("We read this as bad news.");
    expect(within(dialog).getByTestId("news-sheet-tag").textContent).toContain(
      "Bad for our trades · rule-based",
    );
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`/api/news/${id}`);
    vi.unstubAllGlobals();
  });
});

describe("axe (AT-26)", () => {
  it("has no violations on any chip, for every role", async () => {
    for (const who of ALL) {
      for (const chip of ["mine", "all", "alerts"]) {
        as(w, who);
        const { container } = render(await NewsPage({ searchParams: sp({ chip }) }));
        const r = await axe.run(container, {
          rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
        });
        expect(r.violations.map((v) => `${who}/${chip}: ${v.id}`)).toEqual([]);
        cleanup();
      }
    }
  });
});

describe("C9 redesign (UXR-025, UXR-045, UXR-052)", () => {
  it("keeps ?chip=alerts working for the Home link and marks Alerts as the selected segment", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    const nav = screen.getByRole("navigation", { name: "News view" });
    const alertsLink = within(nav).getByRole("link", { name: /^Alerts/ });
    expect(alertsLink).toHaveAttribute("href", "/news?chip=alerts");
    expect(alertsLink).toHaveAttribute("aria-current", "page");
    expect(alertsLink.textContent).toContain("(Selected)");
    expect(alertsLink.querySelector("svg")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "All news" })).not.toHaveAttribute("aria-current");
  });

  it("shows the search field on every chip", async () => {
    as(w, "owner");
    for (const chip of ["all", "mine", "alerts"]) {
      render(await NewsPage({ searchParams: sp({ chip }) }));
      expect(screen.getByLabelText("Search")).toBeEnabled();
      cleanup();
    }
  });

  it("news rows carry headline, source, time and a text materiality pill, with no accordion", async () => {
    as(w, "owner");
    const { container } = render(await NewsPage({ searchParams: sp({ chip: "all" }) }));
    for (const card of screen.getAllByTestId("news-card")) {
      expect(within(card).getByTestId("news-source").textContent).toBe(
        "Source: exchange announcement",
      );
      const pill = card.querySelector('[data-kind="tier"], [data-kind="status"]');
      expect(pill).not.toBeNull();
      expect(pill!.textContent).toMatch(/P[012] (Urgent|Important|FYI)|Not important/);
    }
    expect(container.querySelector("ul[aria-label='News'] details")).toBeNull();
  });

  it("alerts show a tier-coloured P-level pill with text, a tier rail and the action", async () => {
    as(w, "owner");
    render(await NewsPage({ searchParams: sp({ chip: "alerts" }) }));
    await actionsLoaded();
    const items = screen.getAllByTestId("alert-item");
    for (const item of items) {
      const pill = item.querySelector('[data-kind="tier"]')!;
      expect(pill.textContent).toMatch(/P[012] (Urgent|Important|FYI)/);
      expect(item.querySelector("[data-hue^='tier-']")).not.toBeNull();
    }
    const p0 = items.find((i) => i.textContent?.includes("Trading halt on"))!;
    expect(p0.querySelector('[data-kind="tier"]')!.textContent).toBe("P0 Urgent");
    expect(p0.querySelector("[data-hue]")!.getAttribute("data-hue")).toBe("tier-p0");
    expect(within(p0).getByRole("button", { name: /^Acknowledge/ })).toBeVisible();
  });
});
