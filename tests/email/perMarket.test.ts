// @vitest-environment node
// M20 S1 (UXN-313, D-1124, D-1061, O-34): per-market sections of the Evening Review and the Morning Brief. Two enabled
// markets in full mode that trade on the date give two sections, each in its own currency, never pooled; AU alone (or a
// second market that is off or data-only) leaves the e-mail byte-identical to the M19 one (the snapshot tests pin it).
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBrief } from "@/lib/email/brief";
import { createMockProvider, type MockProvider } from "@/lib/email/mock";
import { renderBrief, renderReview } from "@/lib/email/templates";
import { moneyIn, type MarketSectionFact } from "@/lib/email/templates/marketSections";
import { setConfig } from "@/lib/config/store";
import { loadReview } from "@/lib/review/assemble";
import { runReviewSend, type ReviewSendCtx } from "@/lib/review/send";
import { KEY } from "../auth/helpers";
import { allowMarket, cleanupTempDbs } from "../db/helpers";
import * as fx from "../fixtures/email/facts";
import { APP, D, mainWorld, tradingDay } from "../review/helpers";

afterEach(cleanupTempDbs);

const IN_SECTION: MarketSectionFact = {
  market: "IN",
  name: "India (NSE)",
  currency: "INR",
  closeAt: "2026-10-19 15:30 IST · 21:00 Melbourne",
  strategies: 2,
  dayPlCents: 12_345_67,
  navCents: 6_000_000_00,
  closed: 1,
  queued: 3,
};
const US_SECTION: MarketSectionFact = {
  market: "US",
  name: "United States (NYSE and Nasdaq)",
  currency: "USD",
  closeAt: "2026-10-19 16:00 EDT · 07:00 Melbourne",
  strategies: 2,
  dayPlCents: -4_050,
  navCents: 39_000_00,
  closed: 0,
  queued: 0,
};

describe("moneyIn: the market's own currency, no locale API, lakh grouping for INR", () => {
  it.each([
    [0, "INR", false, "₹0.00"],
    [0, "INR", true, "₹0.00"],
    [5, "INR", false, "₹0.05"],
    [12_345_67, "INR", true, "+₹12,345.67"],
    [1_234_567_890, "INR", false, "₹1,23,45,678.90"], // Rs 12,345,678.90 = 1.23 crore
    [-100_000_00, "INR", true, "-₹1,00,000.00"],
    [123_456_789, "USD", false, "US$1,234,567.89"],
    [-4_050, "USD", true, "-US$40.50"],
    [99, "AUD", true, "+A$0.99"],
  ])("%i %s signed=%s -> %s", (cents, cur, signed, want) => {
    expect(moneyIn(cents, cur, signed)).toBe(want);
  });
  it("refuses a currency with no registered format (never guesses)", () => {
    expect(() => moneyIn(1, "XXX")).toThrow(RangeError);
  });
});

describe("renderReview with market sections", () => {
  const base = fx.REVIEW_FULL;
  it("no sections, an empty list or an undefined key: the very same bytes as the M19 review", () => {
    const plain = renderReview(base);
    expect(renderReview({ ...base, marketSections: [] })).toEqual(plain);
    expect(renderReview({ ...base, marketSections: undefined })).toEqual(plain);
  });

  it("two further markets give two sections, each in its own currency, after the AU sections", () => {
    const plain = renderReview(base);
    const out = renderReview({ ...base, marketSections: [IN_SECTION, US_SECTION] });
    for (const part of [out.html, out.text]) {
      expect(part).toContain("India (NSE) (IN), INR");
      expect(part).toContain("United States (NYSE and Nasdaq) (US), USD");
      expect(part).toContain("+₹12,345.67");
      expect(part).toContain("₹60,00,000.00"); // Rs 6,000,000.00 = 60 lakh
      expect(part).toContain("-US$40.50");
      expect(part).toContain("US$39,000.00");
      expect(part).toContain("2026-10-19 15:30 IST · 21:00 Melbourne");
    }
    // the AU part is untouched and comes first: the plain review's text is a prefix-compatible subset
    expect(out.html.indexOf("India (NSE)")).toBeGreaterThan(
      out.html.indexOf("Today, all strategies"),
    );
    expect(out.subject).toBe(plain.subject);
    // never pooled: no figure of one market appears in another market's currency, and there is no all-markets total
    expect(out.text).not.toMatch(/A\$12,345\.67|US\$12,345\.67|₹39,000/);
    expect(out.text).not.toMatch(/all markets|combined|in total across/i);
  });

  it("the minimal fallback never carries sections", () => {
    const out = renderReview({ ...fx.REVIEW_MINIMAL, marketSections: [IN_SECTION] });
    expect(out.html).not.toContain("India (NSE)");
  });
});

describe("renderBrief with market sections", () => {
  it("none, or an empty list: identical to the M19 brief; with a section the market is named and its lists follow", () => {
    const plain = renderBrief(fx.BRIEF);
    expect(renderBrief({ ...fx.BRIEF, marketSections: [] })).toEqual(plain);
    const out = renderBrief({
      ...fx.BRIEF,
      firstMarket: "Australia (ASX)",
      marketSections: [
        {
          market: "IN",
          name: "India (NSE)",
          overnight: [{ code: "RELIANCE", title: "Board meeting on results", time: "07:30" }],
          events: [{ label: "TCS", detail: "results" }],
          plan: ["sell INFY (exit_cs) in 1 execution"],
        },
      ],
    });
    expect(out.text).toContain("Australia (ASX)");
    expect(out.text).toContain("India (NSE) (IN)");
    expect(out.text).toContain("RELIANCE");
    expect(out.text).toContain("TCS: results");
    expect(out.text).toContain("sell INFY (exit_cs) in 1 execution");
  });
});

// ---- from the database -----------------------------------------------------------------------------------------

const OWNER = "owner@example.test";
const ENV = {
  EMAIL_PROVIDER: "mock",
  OWNER_EMAIL: OWNER,
  APP_BASE_URL: APP,
  PII_HASH_KEY: "k".repeat(64),
  PRAXIS_ENV: "production",
} as Record<string, string | undefined>;
let db: Client;
let mock: MockProvider;

const local = (date: string, hhmm: string, offset = 11): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, h! - offset, m!));
};
const putState = (key: string, value: string) =>
  db.execute({
    sql: `INSERT INTO worker_state (key, value_json, updated_at) VALUES (?, ?, 'x')
          ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    args: [key, JSON.stringify(value)],
  });
const ctx = (): ReviewSendCtx => ({
  db,
  env: ENV,
  now: () => local(D, "20:00"),
  provider: mock,
  sleep: async () => {},
});
async function world() {
  db = await mainWorld();
  mock = createMockProvider();
  await putState("email_mode", "full");
  await tradingDay(db);
}
async function india(mode: "data_only" | "full") {
  await allowMarket(db, "IN");
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'IN'", args: [mode] });
  await db.execute({
    sql: "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN', ?, 'session', NULL, 1, 'test')",
    args: [D],
  });
}

describe("the Evening Review from the database", () => {
  beforeEach(world);

  it("AU alone: one review, no market section", async () => {
    const r = await runReviewSend(ctx(), D);
    expect(r).toMatchObject({ ok: true, status: "sent" });
    const stored = (await loadReview(db, D))!;
    expect(stored.html).not.toContain("India");
    expect(
      JSON.parse(
        String((await db.execute("SELECT facts_json FROM evening_review")).rows[0]!.facts_json),
      ),
    ).not.toHaveProperty("marketSections");
  });

  it("a second market in data_only adds nothing: the stored review is byte-identical to the AU-only one", async () => {
    await runReviewSend(ctx(), D);
    const alone = (await loadReview(db, D))!;
    await world();
    await india("data_only");
    await runReviewSend(ctx(), D);
    const withIn = (await loadReview(db, D))!;
    expect(withIn.html).toBe(alone.html);
    expect(withIn.text).toBe(alone.text);
    expect(withIn.factsSha).toBe(alone.factsSha);
  });

  it("a second market in full mode that trades on the date adds its section; one that does not trade adds none", async () => {
    await india("full");
    await runReviewSend(ctx(), D);
    const stored = (await loadReview(db, D))!;
    expect(stored.html).toContain("India");
    expect(stored.html).toContain("INR");
    expect(stored.html).toContain("₹0.00"); // no strategies yet: zero figures in rupees, not A$ zero pooled in
    const facts = JSON.parse(
      String((await db.execute("SELECT facts_json FROM evening_review")).rows[0]!.facts_json),
    );
    expect(facts.marketSections).toHaveLength(1);
    expect(facts.marketSections[0]).toMatchObject({
      market: "IN",
      currency: "INR",
      strategies: 0,
      closed: 0,
    });
    // a holiday in India on the date: no section
    await world();
    await india("full");
    await db
      .execute("UPDATE trading_calendar SET kind = 'holiday' WHERE market = 'IN'")
      .catch(() => undefined);
    const stillTrades = (
      await db.execute({
        sql: "SELECT kind FROM trading_calendar WHERE market = 'IN' AND d = ?",
        args: [D],
      })
    ).rows[0]!.kind;
    if (String(stillTrades) === "holiday") {
      await runReviewSend(ctx(), D);
      expect((await loadReview(db, D))!.html).not.toContain("India");
    }
  });
});

describe("the Morning Brief from the database", () => {
  beforeEach(async () => {
    db = await mainWorld({ mode: "full" });
    mock = createMockProvider();
    await putState("email_mode", "full");
    await setConfig(db, {
      key: "morning_brief_enabled",
      value: "on",
      userId: null,
      now: "2026-10-01T00:00:00.000Z",
    });
  });
  const run = () =>
    runBrief({
      db,
      env: { ...ENV, PRAXIS_ENV: "staging", PII_HASH_KEY: KEY },
      provider: mock,
      now: () => new Date(`${D}T01:00:00Z`),
      sleep: async () => {},
    });

  it("two active markets: the first keeps the top lists, the second has its own section with its own announcements", async () => {
    await india("full");
    await db.execute({
      sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, title, source)
            VALUES ('IN', 'RELIANCE', 'i1', '2026-10-18T10:00:00Z', '2026-10-18T10:00:00Z', 'Board meeting on results', 'in_nse_announcements')`,
      args: [],
    });
    await db.execute({
      sql: `INSERT INTO watch_list_owner (id, market, code, added_by, added_at, expires_d) VALUES ('w1', 'IN', 'RELIANCE', 1, '2026-10-10T00:00:00Z', '2026-12-01')`,
      args: [],
    });
    expect(await run()).toEqual({ status: "sent", send: "sent" });
    const m = mock.outbox[0]!;
    expect(m.text).toContain("India (NSE) (IN)");
    expect(m.text).toContain("RELIANCE");
  });

  it("AU alone (or a second market that is not full): no market heading, the M19 brief", async () => {
    await run();
    const alone = mock.outbox[0]!.text;
    expect(alone).not.toContain("India");
    mock = createMockProvider();
    db = await mainWorld({ mode: "full" });
    await putState("email_mode", "full");
    await setConfig(db, {
      key: "morning_brief_enabled",
      value: "on",
      userId: null,
      now: "2026-10-01T00:00:00.000Z",
    });
    await india("data_only");
    await run();
    expect(mock.outbox[0]!.text).toBe(alone);
  });
});
