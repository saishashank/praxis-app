// M7 T14 Picks pages (UXN-040..045, ch.16 16.21 acceptance, AT-25/AT-27): list, Why this pick and
// Track record, rendered from a real (temporary) database through the page components.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { emptyWorld, envOf, fullWorld, D, SHA, type Who, type World } from "../loaders/world";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { setConfig } from "@/lib/config/store";
import PicksPage from "@/app/(app)/picks/page";
import WhyPage from "@/app/(app)/picks/[id]/page";
import TrackRecordPage from "@/app/(app)/picks/track-record/page";
import { SuccessStrip } from "@/app/(app)/picks/SuccessStrip";
import {
  capPerFamily,
  EMPTY_PICKS_SENTENCE,
  honestyLine,
  timeFrameText,
} from "@/app/(app)/picks/text";
import { loadPicks } from "@/lib/ui/loaders/picks";
import { successLine, type ModelSuccess } from "@/lib/picks/success";

let current: LoaderEnv;
vi.mock("@/lib/auth/guard", () => ({ requireUser: vi.fn(async () => ({ id: 1, role: "owner" })) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/ui/loaders/shell", async (orig) => ({
  ...(await orig<typeof import("@/lib/ui/loaders/shell")>()),
  envFor: async () => current,
}));

afterAll(cleanupTempDbs);
afterEach(cleanup);

const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const as = (w: World, who: Who) => {
  current = envOf(w, who);
};

async function addPick(w: World, rank: number, code: string, family: string) {
  await w.main.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, 'balanced', ?, ?, ?, 'U1', 'x.v1', 's1', 'UNVALIDATED', 10000000, 10050000,
            '2026-10-23', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000,
            '[]', '["a reason"]', ?, ?)`,
    args: [D, rank, code, family, SHA, `${D}T07:00:00.000Z`],
  });
}

describe("Picks list", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
    // The family sheet's panel is a lazy chunk (Sheet.tsx); load it once here so the 1 s findBy* wait
    // below is not spent on the first transform of the Radix dialog (same as tests/strategies/c7).
    await import("@/components/ui/SheetPanel");
  }, 60_000);

  it("shows the family badge with plain words, an info sheet and the Today / Track record tabs (UXR-021, UXN-311)", async () => {
    as(w, "owner");
    render(await PicksPage({ searchParams: sp() }));
    const card = screen.getAllByTestId("pick-card")[0]!;
    const badge = card.querySelector("[data-family]")!;
    expect(badge.getAttribute("data-family")).toBe("br");
    expect(badge.textContent).toContain("Breakout");
    expect(card.querySelector("[data-hue=family-br]")).not.toBeNull();
    fireEvent.click(within(card).getByRole("link", { name: "About Breakout" }));
    const sheet = await screen.findByTestId("family-sheet");
    expect(sheet.textContent).toContain("Buys when");
    expect(sheet.textContent).toContain("Usually breaks when");
    cleanup();
    render(await PicksPage({ searchParams: sp() }));
    const tabs = screen.getByRole("navigation", { name: "Picks view" });
    expect(within(tabs).getByRole("link", { name: /Today/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(tabs).getByRole("link", { name: "Track record" })).toHaveAttribute(
      "href",
      "/picks?profile=balanced&view=track",
    );
  });

  it("renders the Track record tab on /picks?view=track and keeps the old route", async () => {
    as(w, "owner");
    render(await PicksPage({ searchParams: sp({ view: "track" }) }));
    const tabs = screen.getByRole("navigation", { name: "Picks view" });
    expect(within(tabs).getByRole("link", { name: /Track record/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("pick-card")).toBeNull();
    cleanup();
    render(await TrackRecordPage({ searchParams: sp() }));
    expect(screen.getByRole("heading", { level: 1, name: "Track record" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("masked roles still see the family badge but no code, company or price", async () => {
    as(w, "viewer");
    const { container } = render(await PicksPage({ searchParams: sp() }));
    expect(container.querySelector("[data-family]")?.textContent).toContain("Breakout");
    expect(container.textContent).not.toContain("ZZUP");
    expect(container.textContent).not.toContain("A$");
  });

  it("shows the profile switch, success strip, cards and the honesty line to the Owner", async () => {
    as(w, "owner");
    render(await PicksPage({ searchParams: sp() }));
    expect(screen.getByRole("heading", { level: 1, name: "Picks" })).toBeInTheDocument();
    const chips = screen.getByRole("navigation", { name: "Risk profile" });
    expect(
      within(chips)
        .getAllByRole("link")
        .map((a) => a.textContent?.replace(" (Selected)", "")),
    ).toEqual(["Aggressive", "Balanced", "Conservative"]);
    // UXR-002: fill + check + the word "Selected" on the chosen profile only.
    const on = within(chips).getByRole("link", { name: /Balanced/ });
    expect(on).toHaveAttribute("aria-current", "page");
    expect(on.textContent).toContain("(Selected)");
    expect(on.querySelector("svg")).not.toBeNull();
    expect(on.className).toContain("bg-accent");
    expect(within(chips).getByRole("link", { name: "Aggressive" })).not.toHaveAttribute(
      "aria-current",
    );
    // The profile sentence sits directly under the control.
    expect(chips.parentElement?.querySelector("p")?.textContent).toContain("Balanced: Picks from");
    expect(screen.getByTestId("success-line").textContent).toBe(
      "Model success: not measured yet — 1 of 30 picks closed",
    );
    const cards = screen.getAllByTestId("pick-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("ZZUP");
    expect(cards[0]!.textContent).toContain("Zed Upward Holdings");
    expect(cards[0]!.textContent).toContain("A$10.05");
    expect(cards[0]!.textContent).toContain("Closed +5%");
    expect(cards[0]!.textContent).toContain("Stop-loss");
    expect(cards[0]!.textContent).toContain("Suggested size");
    expect(within(cards[0]!).getByText("Simulated")).toBeInTheDocument();
    for (const h of screen.getAllByTestId("honesty-line")) {
      expect(h.textContent).toBe("Personal use only · Not financial advice · Model not proven yet");
    }
    expect(within(cards[0]!).getByRole("link", { name: /Why this pick/ })).toHaveAttribute(
      "href",
      `/picks/${D}.balanced.1`,
    );
    // Decision support only: nothing can place an order (UX-130, PRD-001).
    expect(screen.queryByRole("button", { name: /buy now|sell|place.*order/i })).toBeNull();
    // The only form is the sort toggle (UXN-309, D-474): one hidden field, no order control.
    expect(
      document.querySelector("form:not([data-testid=sort-toggle]), input:not([type=hidden])"),
    ).toBeNull();
  });

  it("O-76/D-791: picks_max_per_family is pinned to 10, so no per-family cap reaches the page", async () => {
    await addPick(w, 3, "ZZDN", "F1");
    await addPick(w, 4, "ZZOTH", "F2");
    as(w, "owner");
    // A value below 10 is refused (the V1 values 1..5 can no longer re-introduce the cap).
    for (const value of [1, 2, 3, 9]) {
      await expect(
        setConfig(w.main, {
          key: "picks_max_per_family",
          value,
          userId: null,
          now: "2026-10-19T00:00:00.000Z",
        }),
      ).rejects.toThrow();
    }
    render(await PicksPage({ searchParams: sp() }));
    expect(screen.getAllByTestId("pick-card")).toHaveLength(4); // all of F1 and F2 shown
  });

  it("capPerFamily keeps order and never exceeds the cap", () => {
    const rows = ["F1", "F1", "F2", "F1", "F2", "F3"].map((family, i) => ({ family, i }));
    expect(capPerFamily(rows, 2).map((r) => r.i)).toEqual([0, 1, 2, 4, 5]);
    expect(capPerFamily(rows, 1).map((r) => r.i)).toEqual([0, 2, 5]);
  });

  it("masks code, company, prices, size and exact dates for an Editor and a Viewer", async () => {
    for (const who of ["editor", "viewer"] as const) {
      as(w, who);
      const { container } = render(await PicksPage({ searchParams: sp() }));
      const text = container.textContent ?? "";
      for (const leak of ["ZZUP", "ZZDN", "ZZOTH", "Zed ", "A$", D])
        expect(text).not.toContain(leak);
      expect(text).toContain("Stock");
      expect(container.innerHTML).not.toMatch(/d{4}-d{2}-d{2}/); // hrefs included
      expect(container.querySelector('a[href^="/picks/pk%3A"]')).not.toBeNull();
      expect(text).toContain("Hidden for your role");
      expect(container.querySelector("[data-money]")).toBeNull();
      cleanup();
    }
  });

  it("shows prices to a Viewer with a live unmask grant", async () => {
    as(w, "granted");
    const { container } = render(await PicksPage({ searchParams: sp() }));
    expect(container.textContent).toContain("ZZUP");
    expect(container.textContent).toContain("A$10.05");
  });

  it("shows the missed state as missed, not as a win or a loss", async () => {
    await addPick(w, 5, "ZZUP", "F5");
    await w.main.execute({
      sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
            VALUES ('AU', ?, 'balanced', 5, 'pick', 'ZZUP', ?, 'waiting', ?)`,
      args: [D, SHA, D],
    });
    await w.main.execute({
      sql: `UPDATE pick_outcome SET state = 'missed', updated_d = ? WHERE rank = 5 AND kind = 'pick'`,
      args: [D],
    });
    // D-187: the nightly check that withdrew it, and why
    await w.main.execute({
      sql: `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
            VALUES ('AU', ?, 'balanced', 5, '2099-01-02', 0, 'regime', ?)`,
      args: [D, `${D}T08:00:00.000Z`],
    });
    as(w, "owner");
    render(await PicksPage({ searchParams: sp() }));
    expect(
      screen
        .getAllByTestId("state-badge")
        .some((b) => b.textContent === "Withdrawn — the market turned against this strategy"),
    ).toBe(true);
    cleanup();
    render(await TrackRecordPage({ searchParams: sp() }));
    expect(
      screen.getAllByText(
        /Withdrawn — the market turned against this strategy \(not a win or a loss\)/,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("rejects an unknown profile and a malformed date with a 404", async () => {
    as(w, "owner");
    await expect(PicksPage({ searchParams: sp({ profile: "wild" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(PicksPage({ searchParams: sp({ d: "2026-13-45" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    await expect(TrackRecordPage({ searchParams: sp({ profile: "../x" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("has no axe violations on the list, with fixed-width classes absent (360 px safe)", async () => {
    as(w, "owner");
    const { container } = render(await PicksPage({ searchParams: sp() }));
    const r = await axe.run(container, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    expect(container.innerHTML).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/);
    expect(container.querySelector("main")?.className).toContain("min-w-0");
  });
});

describe("empty and stale states", () => {
  it("says there are no picks yet in data-only mode, with no sample rows", async () => {
    const w = await emptyWorld();
    as(w, "owner");
    render(await PicksPage({ searchParams: sp() }));
    expect(screen.getByText("No picks yet")).toBeInTheDocument();
    expect(screen.getByText(EMPTY_PICKS_SENTENCE)).toBeInTheDocument();
    expect(screen.getByTestId("picks-empty").querySelector("svg")).not.toBeNull();
    expect(screen.queryAllByTestId("pick-card")).toHaveLength(0);
    cleanup();
    render(await TrackRecordPage({ searchParams: sp() }));
    expect(screen.getByText("No tracked picks yet")).toBeInTheDocument();
  });

  it("shows the stale banner with the last good date", async () => {
    const w = await fullWorld();
    current = { ...envOf(w, "owner"), now: new Date("2026-10-30T03:00:00.000Z") };
    render(await PicksPage({ searchParams: sp() }));
    expect(screen.getByRole("alert").textContent).toContain(D);
  });
});

describe("Success strip (UXN-041)", () => {
  const base: ModelSuccess = {
    profile: "balanced",
    measured: true,
    confidencePct: 90,
    minN: 30,
    closed: 41,
    open: 7,
    missed: 2,
    wins: 24,
    winPct: 59,
    lowerPct: 46,
    upperPct: 70,
    luckClosed: 41,
    luckWins: 20,
    luckPct: 49,
    insidePct: 80,
    since: "2026-10-01",
    beatsLuck: false,
  };

  it("reads 59% of 41 with the Wilson range, open count and luck check", () => {
    render(<SuccessStrip success={{ ...base, line: successLine(base) }} profile="balanced" />);
    const line = screen.getByTestId("success-line").textContent!;
    expect(line).toContain("59% of 41 closed picks made money");
    expect(line).toContain("90% range 46–70%");
    expect(line).toContain("7 still open");
    expect(line).toContain("luck check 49%");
    expect(
      screen.getByRole("img", { name: /59% made money; range 46 to 70 percent/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Picks are chosen by strength of evidence, then signal score/),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 withdrawn before buying/)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/picks/track-record?profile=balanced",
    );
  });

  it("drops 'Model not proven yet' only when the record beats the luck check", () => {
    expect(honestyLine(false)).toContain("Model not proven yet");
    expect(honestyLine(true)).toBe("Personal use only · Not financial advice");
    render(
      <SuccessStrip
        success={{ ...base, beatsLuck: true, line: successLine(base) }}
        profile="balanced"
      />,
    );
    expect(screen.queryByText("Model: not proven yet")).toBeNull();
  });

  it("shows no percentage and no bar before the minimum is reached", () => {
    const s: ModelSuccess = {
      ...base,
      measured: false,
      closed: 7,
      winPct: null,
      lowerPct: null,
      upperPct: null,
      insidePct: null,
    };
    render(<SuccessStrip success={{ ...s, line: successLine(s) }} profile="balanced" />);
    expect(screen.getByTestId("success-line").textContent).toBe(
      "Model success: not measured yet — 7 of 30 picks closed",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("turns sessions into weeks", () => {
    expect(timeFrameText(15)).toBe("about 3 weeks");
    expect(timeFrameText(3)).toBe("about 3 days");
    expect(timeFrameText(null)).toBeNull();
  });
});

describe("Why this pick", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
  });

  it("shows numbered reasons, how the numbers were worked out, factors and the honesty line", async () => {
    as(w, "owner");
    const { container } = render(
      await WhyPage({ params: Promise.resolve({ id: `${D}.balanced.1` }) }),
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("ZZUP");
    expect(screen.getByRole("heading", { name: "Based on" })).toBeInTheDocument();
    expect(
      container.querySelector("section[aria-labelledby=based-h] ol li")?.textContent,
    ).toContain("broke out");
    expect(
      screen.getByRole("heading", { name: "How these numbers were worked out" }),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("no more than 10% in one company");
    expect(container.textContent).toContain("Prices can gap past a stop-loss");
    expect(container.textContent).toContain("Volume of ZZUP");
    expect(container.textContent).toContain("result after costs +5%");
    expect(screen.getByTestId("honesty-line").textContent).toContain("Model not proven yet");
    expect(document.querySelector("form, input, button[type=submit]")).toBeNull();
    const r = await axe.run(container, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it("masks the detail for an Editor and resolves only the opaque pk: reference", async () => {
    as(w, "editor");
    const list = await loadPicks(current, { profile: "balanced" });
    const ref = list.picks[0]!.id;
    expect(ref).toMatch(/^pk:[0-9a-f]{16}$/);
    const { container } = render(
      await WhyPage({ params: Promise.resolve({ id: encodeURIComponent(ref) }) }),
    );
    const text = container.textContent ?? "";
    for (const leak of ["ZZUP", "Zed ", "A$", "10050000"]) expect(text).not.toContain(leak);
    expect(text).toContain("Stock");
    expect(container.innerHTML).not.toMatch(/d{4}-d{2}-d{2}/);
    cleanup();
    // A real date.profile.rank id gives the same 404 as an unknown one.
    for (const id of [`${D}.balanced.1`, "pk:0000000000000000"]) {
      await expect(WhyPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
    as(w, "owner");
    render(await WhyPage({ params: Promise.resolve({ id: encodeURIComponent(ref) }) }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("ZZUP");
  });

  it("is a 404 for a bad or unknown id", async () => {
    as(w, "owner");
    for (const id of ["garbage", `${D}.balanced.9`, "%E0%A4%A"]) {
      await expect(WhyPage({ params: Promise.resolve({ id }) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });
});

describe("Track record", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
  });

  it("shows what was published next to what happened, and offers no way to change it", async () => {
    as(w, "owner");
    const { container } = render(await TrackRecordPage({ searchParams: sp() }));
    expect(screen.getByRole("heading", { level: 1, name: "Track record" })).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).toContain("A$10.05"); // buy up to, as published
    expect(text).toContain("A$9.20"); // stop
    expect(text).toContain("A$11.00"); // aim
    expect(text).toContain("-6% to +11%"); // bad to good range
    expect(text).toContain("+5% after costs");
    expect(text).toContain("aim reached");
    expect(text).toContain("inside the expected range");
    expect(text).toContain("Nothing shown here can be changed afterwards");
    // Immutable: no form, input, button or editing control anywhere in the page body.
    expect(
      container.querySelector("form, input, textarea, select, button[type=submit]"),
    ).toBeNull();
    for (const b of Array.from(container.querySelectorAll("button"))) {
      expect(b.textContent).not.toMatch(/edit|delete|save|update|remove|re-?run/i);
    }
    const r = await axe.run(container, {
      runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it("renders the same after an attempted edit: the database refuses it and the page reads stored rows", async () => {
    as(w, "owner");
    const before = render(await TrackRecordPage({ searchParams: sp() })).container.innerHTML;
    cleanup();
    await expect(w.main.execute("UPDATE pick SET stop_micro = 1 WHERE rank = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(
      w.main.execute("UPDATE pick_outcome SET net_ppm = 1 WHERE rank = 1 AND kind = 'pick'"),
    ).rejects.toThrow();
    const after = render(await TrackRecordPage({ searchParams: sp() })).container.innerHTML;
    expect(after).toBe(before);
  });

  it("has no server action, no write call and no raw database access in the Picks pages", () => {
    const dir = path.resolve(import.meta.dirname, "..", "..", "src", "app", "(app)", "picks");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/["']use server["']/);
      expect(src, f).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?/);
      expect(src, f).not.toMatch(/from "@\/lib\/picks/); // D-136: only the loader imports it
      expect(src, f).not.toMatch(/mainDb\(/);
    }
  });

  it("masks codes, prices and exact dates for an Editor and a Viewer", async () => {
    for (const who of ["editor", "viewer"] as const) {
      as(w, who);
      const { container } = render(await TrackRecordPage({ searchParams: sp() }));
      const text = container.textContent ?? "";
      for (const leak of ["ZZUP", "ZZOTH", "Zed ", "A$", D]) expect(text).not.toContain(leak);
      expect(text).toContain("Stock");
      expect(text).toContain("2026-W43");
      expect(container.innerHTML).not.toMatch(/d{4}-d{2}-d{2}/);
      expect(text).toContain("Price only — dividends not included.");
      expect(text).toContain("+5% after costs"); // percentages carry no price
      expect(container.querySelector("[data-money]")).toBeNull();
      cleanup();
    }
  });

  it("shows the table from 600 px up and a stacked card list below it", async () => {
    as(w, "owner");
    const { container } = render(await TrackRecordPage({ searchParams: sp() }));
    expect(container.querySelector("table")?.className).toContain("sm:table");
    expect(container.querySelector("table")?.className).toContain("hidden");
    expect(
      container.querySelector("ul[aria-label='Track record of published picks']")?.className,
    ).toContain("sm:hidden");
  });
});
