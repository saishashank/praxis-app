// @vitest-environment node
// M7 T17: the Reviews tab (list, search, pending state, calendar), the Evening Review page additions
// (AI / no-AI badge, partial marker, delivery status, section 7a, opaque reference for masked users)
// and the Glossary. UX-080, UXN-113, UXN-206, UX-071b, UX-009 (D-129, D-140, D-144 draft).
// Real migrations on a local file; the guard and the database handles are the only mocks. The older
// per-page tests stay in pages.test.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser } from "../auth/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const notFoundMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
const dbRef = vi.hoisted(() => ({ db: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ notFound: () => notFoundMock() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbRef.db, authDb: () => dbRef.auth }));

import ReviewsPage from "@/app/(app)/reviews/page";
import GlossaryPage from "@/app/(app)/reviews/glossary/page";
import ReviewDatePage from "@/app/(app)/reviews/[date]/page";
import { GLOSSARY, searchGlossary } from "@/app/(app)/reviews/glossary/entries";
import { markReviewReadAction } from "@/app/(app)/reviews/[date]/actions";
import { assembleReview } from "@/lib/review/assemble";
import {
  loadReviewCalendar,
  loadNextReview,
  loadReviewList,
  loadReviewPage,
  parseReviewsQuery,
  reviewRef,
} from "@/lib/ui/loaders/reviews";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import {
  APP,
  D,
  MARKET,
  NOW,
  addAlert,
  addCard,
  addPending,
  mainWorld,
  tradingDay,
} from "./helpers";

afterEach(cleanupTempDbs);

const CODES = ["ZZUP", "ZZPND", "ZZALR", "ZZPCK"];
const NAMES = ["Zed Upward Holdings", "Zed Pending Mining", "Zed Pick Resources"];
const PARTIAL_D = "2026-10-16";
const NONTRADING_D = "2026-10-15";

let db: Client;
let auth: Client;
let uid: number;
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: uid, email: "e@example.test", name: null, role });
const SHA = "a".repeat(64);

async function insertReview(
  d: string,
  kind: "full" | "partial" | "minimal" | "non_trading",
  narrative: "rules" | "llm",
  facts: object,
  missing: object[] = [],
) {
  await db.execute({
    sql: `INSERT INTO evening_review (d, version, kind, missing_json, facts_json, facts_sha, html, text,
            markdown, size_html, narrative, created_at)
          VALUES (?, 1, ?, ?, ?, ?, '<p>stored ZZUP</p>', 'text ZZUP', 'md', 10, ?, ?)`,
    args: [
      d,
      kind,
      JSON.stringify(missing),
      JSON.stringify(facts),
      SHA,
      narrative,
      `${d}T09:00:00.000Z`,
    ],
  });
}

const list = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await ReviewsPage({ searchParams: Promise.resolve(sp) }));
const glossary = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await GlossaryPage({ searchParams: Promise.resolve(sp) }));
const page = async (date: string, sp: { v?: string; src?: string } = {}) =>
  renderToStaticMarkup(
    await ReviewDatePage({ params: Promise.resolve({ date }), searchParams: Promise.resolve(sp) }),
  );
const envAt = (role: "owner" | "editor" | "viewer", masked: boolean, now: Date): LoaderEnv => ({
  main: db,
  auth,
  user: { id: uid, role },
  mask: { masked },
  now,
});
const noLeak = (html: string) => {
  for (const c of CODES) {
    expect(html, c).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
  }
  for (const n of NAMES) expect(html.toLowerCase(), n).not.toContain(n.toLowerCase());
};

beforeEach(async () => {
  requireUser.mockReset();
  revalidatePath.mockReset();
  notFoundMock.mockClear();
  db = await mainWorld();
  dbRef.db = db;
  auth = await freshDb("auth");
  dbRef.auth = auth;
  uid = await addUser(auth, { email: "e@example.test", role: "viewer" });
  const { e01 } = await tradingDay(db);
  await addCard(db, e01);
  for (const [code, name] of [
    ["ZZUP", NAMES[0]],
    ["ZZPND", NAMES[1]],
    ["ZZPCK", NAMES[2]],
  ] as const) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO instrument (market, code, name) VALUES (?, ?, ?)",
      args: [MARKET, code, name],
    });
  }
  await addPending(db, e01, "o-pnd", "ZZPND");
  await addAlert(
    db,
    "ann:AU:asx:leak1",
    "P1",
    `${D}T01:00:00.000Z`,
    {
      title: "ZZALR trading halt requested; Zed Upward Holdings update",
      type: "Trading halt",
      url: "https://announcements.example.test/zzalr/1",
      why: "ZZALR is held by E01",
      rule: "r",
      executions: [],
    },
    "announcement",
    "ZZALR",
  );
  await assembleReview(db, { market: MARKET, d: D, env: "production", appUrl: APP, now: NOW });
  await insertReview(
    PARTIAL_D,
    "partial",
    "llm",
    { executions: [{ currency: "AUD", dayPlCents: -500 }] },
    [{ n: 4, name: "What was learned today" }],
  );
  await insertReview(NONTRADING_D, "non_trading", "rules", {});
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar,
            time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json, pick_sha, created_at)
          VALUES (?, ?, 'balanced', 1, 'ZZPCK', 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', 10000000,
            10050000, '2026-10-23', 9200000, 11000000, 50, 10, 1000000000, 100000000, '[]', ?, ?, ?)`,
    args: [MARKET, D, JSON.stringify(["ZZPCK rose on high volume"]), SHA, `${D}T08:00:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at, sent_at)
          VALUES ('review:a', 'production', 'review', ?, 'reserved_review', 'sent', ?, ?)`,
    args: [D, `${D}T09:30:00.000Z`, `${D}T09:31:00.000Z`],
  });
  await db.execute({
    sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at)
          VALUES ('review:b', 'production', 'review', ?, 'reserved_review', 'failed', ?)`,
    args: [PARTIAL_D, `${PARTIAL_D}T09:30:00.000Z`],
  });
});

describe("/reviews list", () => {
  it("is guarded with the read action for /reviews", async () => {
    as("viewer");
    await list();
    expect(requireUser).toHaveBeenCalledWith("read", "/reviews");
  });

  it("the Owner sees dates, kinds, the AI badge, partial markers, delivery status and read state", async () => {
    as("owner");
    const html = await list();
    expect(html).toContain("<h1");
    expect(html).toContain(D);
    expect(html).toContain(PARTIAL_D);
    expect(html).toContain(">Partial<"); // D-200: not "Partial (partial)"
    expect(html).not.toContain("(partial)");
    expect(html).toContain("Non-trading day");
    expect(html).toContain("Written with AI"); // the partial review has an llm narrative
    expect(html).toContain("Written without AI today");
    expect(html).toContain('data-delivery="sent"');
    expect(html).toContain("Emailed");
    expect(html).toContain('data-delivery="failed"');
    expect(html).toContain("Email failed");
    expect(html).toContain("Not emailed"); // the non-trading day has no mail
    expect(html).toContain("Not read yet");
    expect(html).toContain(`href="/reviews/${D}"`);
    expect(html).not.toContain("Mark as read"); // the control lives on the review page, Owner only
  });

  it.each(["viewer", "editor"])(
    "%s sees ISO weeks and opaque links: no exact date, code or name, no Mark as read",
    async (role) => {
      as(role);
      const html = await list();
      expect(html).toContain("Week 2026-W43");
      expect(html).toContain(`href="/reviews/${reviewRef(D)}"`);
      expect(html).not.toContain(`href="/reviews/${D}"`);
      for (const day of [D, PARTIAL_D, NONTRADING_D]) expect(html, day).not.toContain(day);
      expect(html).not.toContain("Mark as read");
      expect(html).toContain("Search by week or kind");
      noLeak(html);
    },
  );

  it("search: the Owner finds a date prefix and review text; a masked user only weeks and kinds", async () => {
    as("owner");
    const byDate = await list({ q: "2026-10-16" });
    expect(byDate).toContain(PARTIAL_D);
    expect(byDate).not.toContain(`href="/reviews/${NONTRADING_D}"`);
    expect(await list({ q: "ZZUP" })).toContain(PARTIAL_D); // matches the stored review text
    expect(await list({ q: "2025" })).toContain("No reviews match");
    as("viewer");
    // The stored text holds a stock code: a masked search must not find it.
    expect(await list({ q: "ZZUP" })).toContain("No reviews match");
    expect(await list({ q: "2026-10-16" })).toContain("No reviews match"); // exact dates are not searchable
    const week = await list({ q: "W43" });
    expect(week).toContain("Week 2026-W43");
    const kind = await list({ q: "partial" });
    expect(kind).toContain(">Partial<");
  });

  it("refuses a bad query with not found", async () => {
    as("owner");
    await expect(list({ q: "<b>" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(list({ view: "grid" })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(list({ month: "2026-13" })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("an empty database shows the empty state, not an error", async () => {
    as("owner");
    await db.execute("DROP TRIGGER evening_review_no_delete");
    await db.execute("DELETE FROM evening_review");
    const html = await list();
    expect(html).toContain("No reviews yet");
  });

  it("validates view and month", () => {
    const sp = (s: string) => new URLSearchParams(s);
    expect(parseReviewsQuery(sp("view=calendar&month=2026-10"))).toMatchObject({
      view: "calendar",
      month: "2026-10",
    });
    expect(parseReviewsQuery(sp("view=list"))?.view).toBeUndefined();
    expect(parseReviewsQuery(sp("month=2026-00"))).toBeNull();
    expect(parseReviewsQuery(sp("view=other"))).toBeNull();
  });
});

describe("pending state (UXR-026: 19:45 to 21:00 on a trading day)", () => {
  // 2026-10-20 is AEDT (UTC+11): 08:45Z = 19:45, 09:50Z = 20:50, 03:00Z = 14:00.
  it("window: no review for today yet and the clock is between 19:30 and 20:45", async () => {
    const m = await loadReviewList(envAt("owner", false, new Date("2026-10-20T08:45:00.000Z")), {
      page: 1,
    });
    expect(m.pending).toBe(true);
    expect(m.pendingState).toBe("window");
  });
  it("late: after the send-by time", async () => {
    const m = await loadReviewList(envAt("owner", false, new Date("2026-10-20T09:50:00.000Z")), {
      page: 1,
    });
    expect(m.pendingState).toBe("late");
  });
  it("nothing before 19:30, and nothing once today's review is stored", async () => {
    const early = await loadReviewList(
      envAt("owner", false, new Date("2026-10-20T03:00:00.000Z")),
      {
        page: 1,
      },
    );
    expect(early.pending).toBe(true);
    expect(early.pendingState).toBeNull();
    const stored = await loadReviewList(
      envAt("owner", false, new Date("2026-10-19T08:45:00.000Z")),
      {
        page: 1,
      },
    );
    expect(stored.pending).toBe(false);
    expect(stored.pendingState).toBeNull();
  });
  it("outside 19:45 to 21:00 Melbourne there is no pending state, and a non-trading day never has one", async () => {
    const at = (iso: string) => loadReviewList(envAt("owner", false, new Date(iso)), { page: 1 });
    expect((await at("2026-10-20T08:44:00.000Z")).pendingState).toBeNull(); // 19:44
    expect((await at("2026-10-20T10:00:00.000Z")).pendingState).toBe("late"); // 21:00
    expect((await at("2026-10-20T10:01:00.000Z")).pendingState).toBeNull(); // 21:01
    expect((await at("2026-10-24T08:50:00.000Z")).pendingState).toBeNull(); // Saturday 19:50
  });
  it("next review line: tonight on a trading day, the next trading day otherwise", async () => {
    const next = (iso: string) => loadNextReview(envAt("owner", false, new Date(iso)));
    expect(await next("2026-10-20T03:00:00.000Z")).toBe("Next review: tonight 20:00");
    expect(await next("2026-10-20T10:30:00.000Z")).toBe("Next review: tomorrow 20:00"); // 21:30 Tue
    expect(await next("2026-10-24T08:50:00.000Z")).toBe("Next review: Monday 20:00"); // Saturday
  });
  it("the page shows the pending notice only while it applies", async () => {
    as("owner");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-20T08:45:00.000Z"));
      expect(await list()).toContain("being prepared");
      vi.setSystemTime(new Date("2026-10-20T09:50:00.000Z"));
      expect(await list()).toContain("is late");
      vi.setSystemTime(new Date("2026-10-20T03:00:00.000Z"));
      const html = await list();
      expect(html).not.toContain("being prepared");
      expect(html).not.toContain("is late");
      expect(html).toContain("Next review: tonight 20:00");
      vi.setSystemTime(new Date("2026-10-24T08:50:00.000Z"));
      const sat = await list();
      expect(sat).not.toContain("being prepared");
      expect(sat).toContain("Next review: Monday 20:00");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reading page and tabs (UXR-026, UXR-052, UXR-002)", () => {
  it("the list has Reviews and Calendar tabs; the current one shows the check and Selected cues", async () => {
    as("owner");
    const html = await list();
    expect(html).toMatch(/aria-current="page"[^>]*><svg[^>]*>.*?<[/]svg>Reviews/);
    expect(html).toContain("(Selected)");
    const cal = await list({ view: "calendar" });
    expect(cal).toMatch(/aria-current="page"[^>]*><svg[^>]*>.*?<[/]svg>Calendar/);
  });
  it("the latest review is offered with a section index whose icons carry the section colours", async () => {
    as("owner");
    const html = await list();
    expect(html).toContain('data-testid="latest-review"');
    expect(html).toContain('data-testid="review-index"');
    expect(html).toContain("Headline scorecard");
    for (const tone of ["home", "strategies", "market", "reviews", "picks", "news"]) {
      expect(html).toContain(`var(--color-section-${tone})`);
    }
  });
  it("a review page shows its section index", async () => {
    as("owner");
    const html = await page(PARTIAL_D);
    expect(html).toContain('data-testid="review-index"');
    expect(html).toContain("Profit / loss");
  });
});

describe("calendar (UXN-206)", () => {
  it("the Owner's month has a cell per day, a link to each stored review and the stored day P/L", async () => {
    const m = await loadReviewCalendar(envAt("owner", false, NOW), { month: "2026-10" });
    expect(m.monthLabel).toBe("October 2026");
    expect(m.prev).toBe("2026-09");
    const cells = m.weeks.flat().filter((c) => c !== null);
    expect(cells.length).toBe(31);
    expect(m.weeks.every((w) => w.length === 7)).toBe(true);
    const partial = cells.find((c) => c!.d === PARTIAL_D)!;
    expect(partial.href).toBe(`/reviews/${PARTIAL_D}`);
    expect(partial.partial).toBe(true);
    expect(partial.pl).toEqual([{ currency: "AUD", cents: -500, text: "-A$5.00" }]);
    expect(cells.find((c) => c!.d === "2026-10-01")!.href).toBe("");
  });

  it("renders for the Owner with glyphs, text amounts and the Simulated label", async () => {
    as("owner");
    const html = await list({ view: "calendar", month: "2026-10" });
    expect(html).toContain("Evening reviews in October 2026");
    expect(html).toContain("▼");
    expect(html).toContain("-A$5.00");
    expect(html).toContain("Simulated");
    expect(html).toContain(`href="/reviews/${PARTIAL_D}"`);
  });

  it.each(["viewer", "editor"])(
    "%s gets one row per ISO week: no day, no exact date, links by week",
    async (role) => {
      as(role);
      const html = await list({ view: "calendar", month: "2026-10" });
      expect(html).toContain("Week 2026-W42"); // 15 and 16 Oct
      expect(html).toContain("Week 2026-W43");
      expect(html).toContain("/reviews?q=2026-W42");
      expect(html).not.toContain("<table");
      for (const day of [D, PARTIAL_D, NONTRADING_D]) expect(html, day).not.toContain(day);
      noLeak(html);
    },
  );

  it("no later month than the current one is offered", async () => {
    const m = await loadReviewCalendar(
      envAt("owner", false, new Date("2026-10-20T03:00:00.000Z")),
      {},
    );
    expect(m.month).toBe("2026-10");
    expect(m.next).toBeNull();
  });
});

describe("/reviews/[date]", () => {
  it("shows the AI / no-AI badge, delivery status and the sections of 7a for the Owner", async () => {
    as("owner");
    const html = await page(D);
    expect(html).toContain('data-provenance="no-ai"');
    expect(html).toContain("Written without AI today");
    expect(html).toContain('data-delivery="sent"');
    expect(html).toContain("New picks");
    expect(html).toContain("ZZPCK");
    expect(html).toContain("Zed Pick Resources");
    expect(html).toContain("A$10.05"); // buy up to, Money
    expect(html).toContain("data-money");
    expect(html).toContain("Simulated");
    expect(html).toContain("Mark as read");
  });

  it("an AI-written, partial review says so and lists the missing sections", async () => {
    as("owner");
    const html = await page(PARTIAL_D);
    expect(html).toContain('data-provenance="ai"');
    expect(html).toContain("Written with AI");
    expect(html).toContain("Partial review");
    expect(html).toContain("4. What was learned today");
    expect(html).toContain('data-delivery="failed"');
    expect(html).toContain("No picks were published for this review.");
  });

  it.each(["viewer", "editor"])(
    "%s: the opaque reference opens the review with weeks only; picks are masked, no Mark as read",
    async (role) => {
      as(role);
      const html = await page(reviewRef(D));
      expect(html).toContain("Evening Review, week 2026-W43");
      expect(html).not.toContain(D);
      expect(html).not.toContain("<iframe");
      expect(html).toContain("New picks");
      expect(html).toContain("Stock ");
      expect(html).toContain("Prices are hidden for your access level");
      expect(html).not.toContain("A$10.05");
      expect(html).not.toContain("data-money");
      expect(html).not.toContain("Mark as read");
      noLeak(html);
      expect(html).not.toMatch(/https?:\/\//);
    },
  );

  it("masked users keep the same letters in the review body and in 7a", async () => {
    as("viewer");
    const m = await loadReviewPage(envAt("viewer", true, NOW), reviewRef(D));
    const stock = m!.newPicks!.profiles[0]!.picks[0]!.stock;
    expect(stock).toMatch(/^Stock [A-Z]+$/);
    const stocks = JSON.stringify(m!.maskedView);
    // Letters are alphabetical over the date set: ZZALR=A, ZZPCK=B, ZZPND=C. The pick letter is the one
    // the review body would use for the same stock, and adding the pick moved ZZPND from B to C.
    expect(stock).toBe("Stock B");
    expect(stocks).toContain("Stock C");
  });

  it("an unknown or foreign reference is not found, like an unknown id", async () => {
    as("viewer");
    await expect(page("rv-0123456789abcdef")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page("rv-zz")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the Owner may use the reference too and then sees the real date", async () => {
    as("owner");
    const html = await page(reviewRef(D));
    expect(html).toContain(`Evening Review ${D}`);
    expect(html).toContain("<iframe");
  });

  it("masked users never get the read time at day precision", async () => {
    as("owner");
    await markReviewReadAction(
      (() => {
        const f = new FormData();
        f.set("d", D);
        f.set("via", "page");
        return f;
      })(),
    );
    as("viewer");
    const html = await page(reviewRef(D));
    expect(html).toContain("Read 2026-W");
    expect(html).not.toMatch(/Read 20\d\d-\d\d-\d\d/);
  });

  it("an unreadable delivery table does not break the page", async () => {
    as("owner");
    await db.execute("DROP TABLE email_message");
    expect(await page(D)).toContain("Not emailed");
  });
});

describe("mark as read stays Owner only", () => {
  it("the action refuses a non-Owner before writing", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    const f = new FormData();
    f.set("d", D);
    f.set("via", "page");
    await expect(markReviewReadAction(f)).rejects.toThrow(/403/);
    const r = await db.execute("SELECT COUNT(*) AS n FROM review_read");
    expect(Number(r.rows[0]!.n)).toBe(0);
    expect(requireUser).toHaveBeenCalledWith("admin", `/reviews/${D}`);
  });

  it("neither the list nor the calendar nor the glossary offers it to anyone", async () => {
    for (const role of ["owner", "editor", "viewer"]) {
      as(role);
      for (const html of [await list(), await list({ view: "calendar" }), await glossary()]) {
        expect(html).not.toContain("Mark as read");
      }
    }
  });
});

describe("/reviews/glossary", () => {
  it("is guarded with the read action and is the same for every role", async () => {
    const seen: string[] = [];
    for (const role of ["owner", "editor", "viewer"]) {
      as(role);
      seen.push(await glossary());
    }
    expect(requireUser).toHaveBeenCalledWith("read", "/reviews/glossary");
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    noLeak(seen[0]!);
  });

  it("explains the spec's terms and anchors Simulated", async () => {
    as("viewer");
    const html = await glossary();
    expect(html).toContain("<h1");
    expect(html).toContain('id="simulated"');
    for (const t of [
      "Chance over time (CIF)",
      "Independent rounds (effective N)",
      "Warning signs",
      "Cost drag",
      "Independent rounds that count",
      "PASSED-BACKTEST",
      "UNVALIDATED",
      "Drop from peak",
      "Stop-loss",
      "Moving average",
      "RSI",
      "Volume",
    ]) {
      expect(html, t).toContain(t);
    }
  });

  it("entries have unique anchors, and every definition fits a popover (40 words)", () => {
    const ids = GLOSSARY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of GLOSSARY) {
      expect(e.meaning.trim().split(/\s+/).length, e.id).toBeLessThanOrEqual(40);
    }
  });

  it("searches terms, official terms and meanings; an empty search lists everything", async () => {
    expect(searchGlossary(undefined).length).toBe(GLOSSARY.length);
    expect(searchGlossary("cif").some((e) => e.id === "cif")).toBe(true);
    expect(searchGlossary("NAV").some((e) => e.term === "Value")).toBe(true); // the official term
    expect(searchGlossary("zzqq")).toEqual([]);
    as("viewer");
    const html = await glossary({ q: "borrowed" });
    expect(html).toContain("Leverage");
    expect(html).not.toContain("Cost drag");
    expect(await glossary({ q: "zzqq" })).toContain("No terms match");
    await expect(glossary({ q: "a\u0000b" })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("/reviews list wording (D-200)", () => {
  it("says once that email is switched off instead of on every row", async () => {
    await db.execute({
      sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, created_at)
            VALUES ('review:c', 'production', 'review', ?, 'reserved_review', 'suppressed_off', ?)`,
      args: [NONTRADING_D, `${NONTRADING_D}T09:30:00.000Z`],
    });
    as("owner");
    const html = await list();
    expect(html).toContain("Email is switched off, so these reviews were not emailed.");
    expect(html).not.toContain('data-delivery="suppressed_off"');
    expect(html).toContain('data-delivery="sent"');
  });
});
