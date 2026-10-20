// @vitest-environment node
// Evening Review pages and the mark-as-read action (M5 T9; EML-036, ROL-102a, decision 29 and 34).
// /reviews/[date]: every signed-in role reads the stored review, only the Owner sees "Mark as read";
// /cards/[id]: read-only for all roles; markReviewReadAction: Owner only, insert-once, validated.
// Masking (DAT-124, ROL-107, UX-009; D-128): Editors and Viewers never receive a stock code, a company
// name, a price or a link on either page; the Owner and a user with a live unmask grant do.
// Real migrations on a local file; the guard and the database handles are the only mocks.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addUser } from "../auth/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbRef = vi.hoisted(() => ({ db: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbRef.db, authDb: () => dbRef.auth }));

import ReviewDatePage from "@/app/(app)/reviews/[date]/page";
import { markReviewReadAction } from "@/app/(app)/reviews/[date]/actions";
import CardPage from "@/app/(app)/cards/[id]/page";
import { assembleReview, readState } from "@/lib/review/assemble";
import {
  APP,
  CARD_ID,
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

// Every synthetic code and company name that exists on the review date. None may reach a non-owner.
const CODES = ["ZZUP", "ZZPND", "ZZALR"];
const NAMES = ["Zed Upward Holdings", "Zed Pending Mining"];

let db: Client;
let auth: Client;
let uid: number;
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: uid, email: "e@example.test", name: null, role });
const grantTo = async (expiresAt: string, revoked = false) =>
  auth.execute({
    sql: `INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at, revoked_at, revoked_by)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      uid,
      uid,
      "2019-01-01T00:00:00.000Z",
      expiresAt,
      revoked ? "2026-02-01T00:00:00.000Z" : null,
      revoked ? uid : null,
    ],
  });
const noLeak = (html: string) => {
  for (const c of CODES) {
    expect(html, c).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${c}(?![A-Za-z0-9])`));
  }
  for (const n of NAMES) expect(html.toLowerCase(), n).not.toContain(n.toLowerCase());
};
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const page = async (date: string, sp: { v?: string; src?: string } = {}) =>
  renderToStaticMarkup(
    await ReviewDatePage({ params: Promise.resolve({ date }), searchParams: Promise.resolve(sp) }),
  );

beforeEach(async () => {
  requireUser.mockReset();
  revalidatePath.mockReset();
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
});

describe("/reviews/[date]", () => {
  it("is guarded with the read action for the date's own path", async () => {
    as("viewer");
    await page(D);
    expect(requireUser).toHaveBeenCalledWith("read", `/reviews/${D}`);
  });

  it("stops (renders nothing) when the guard refuses", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(page(D)).rejects.toThrow(/403/);
  });

  it.each(["viewer", "editor"])(
    "%s reads a MASKED review: no stored HTML, no code, name, price or link, no Mark as read",
    async (role) => {
      as(role);
      const html = await page(D);
      expect(html).toContain("Evening Review 2026-10-19");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("srcdoc");
      expect(html).toContain("Stock A");
      expect(html).toContain("hidden for your access level");
      expect(html).toContain("Not marked as read yet.");
      expect(html).not.toContain("Mark as read</button>");
      noLeak(html);
      expect(html).not.toMatch(/https?:\/\//);
    },
  );

  it("the stored review really does hold the codes (so the masked page is doing the work)", async () => {
    const r = await db.execute("SELECT html, facts_json FROM evening_review");
    const all = String(r.rows[0]!.html) + String(r.rows[0]!.facts_json);
    for (const c of CODES) expect(all, c).toContain(c);
  });

  it("the Owner gets the stored HTML in the sandboxed frame (unmasked)", async () => {
    as("owner");
    const html = await page(D);
    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox=""');
    expect(html).toContain("ZZUP");
  });

  it("an Editor with a live unmask grant sees the stored review", async () => {
    as("editor");
    await grantTo("2099-01-01T00:00:00.000Z");
    expect(await page(D)).toContain("<iframe");
  });

  it("an expired grant does not unmask", async () => {
    as("viewer");
    await grantTo("2020-01-01T00:00:00.000Z");
    const html = await page(D);
    expect(html).not.toContain("<iframe");
    noLeak(html);
  });

  it("a revoked grant does not unmask", async () => {
    as("viewer");
    await grantTo("2099-01-01T00:00:00.000Z", true);
    const html = await page(D);
    expect(html).not.toContain("<iframe");
    noLeak(html);
  });

  it("fails closed: if the grant lookup fails the review stays masked", async () => {
    as("viewer");
    await auth.execute("DROP TABLE unmask_grant");
    const html = await page(D);
    expect(html).not.toContain("<iframe");
    noLeak(html);
  });

  it("the Owner gets Mark as read; opening the page (even from the email link) writes nothing", async () => {
    as("owner");
    const html = await page(D, { src: "email" });
    expect(html).toContain("Mark as read");
    expect(await readState(db, D)).toBeNull();
  });

  it("shows the read state once the date was marked", async () => {
    as("owner");
    await markReviewReadAction(form({ d: D, via: "page" }));
    const html = await page(D);
    expect(html).toContain("Read 20");
    expect(html).toContain("Marked as read.");
  });

  it("says so when no review is stored, and 404s a malformed date", async () => {
    as("viewer");
    expect(await page("2026-01-01")).toContain("No review is stored for 2026-01-01.");
    await expect(page("not-a-date")).rejects.toThrow();
  });
});

describe("markReviewReadAction", () => {
  it("requires admin on the review path before anything else, and writes nothing when refused", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(markReviewReadAction(form({ d: D, via: "page" }))).rejects.toThrow(/403/);
    expect(requireUser).toHaveBeenCalledWith("admin", `/reviews/${D}`);
    expect(await readState(db, D)).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("marks once per date (page or email link) and a repeat is a no-op", async () => {
    as("owner");
    expect(await markReviewReadAction(form({ d: D, via: "email_link" }))).toEqual({
      ok: true,
      firstRead: true,
    });
    expect(await markReviewReadAction(form({ d: D, via: "page" }))).toEqual({
      ok: true,
      firstRead: false,
    });
    expect((await readState(db, D))?.via).toBe("email_link");
    expect(revalidatePath).toHaveBeenCalledWith(`/reviews/${D}`);
  });

  it("rejects bad input and a date with no stored review", async () => {
    as("owner");
    expect(await markReviewReadAction(form({ d: "x", via: "page" }))).toEqual({ error: "invalid" });
    expect(await markReviewReadAction(form({ d: D, via: "other" }))).toEqual({ error: "invalid" });
    expect(await markReviewReadAction(form({ via: "page" }))).toEqual({ error: "invalid" });
    expect(await markReviewReadAction(form({ d: "2026-01-01", via: "page" }))).toEqual({
      error: "not_found",
    });
  });
});

describe("/cards/[id]", () => {
  const card = async (id: string) =>
    renderToStaticMarkup(await CardPage({ params: Promise.resolve({ id }) }));

  it("a Viewer sees a MASKED card: Stock A, no code, name, price, amount or exact date (encoded id)", async () => {
    as("viewer");
    const html = await card(encodeURIComponent(CARD_ID));
    expect(requireUser).toHaveBeenCalledWith("read", `/cards/${encodeURIComponent(CARD_ID)}`);
    expect(html).toContain("Decision Card: Stock C (E01)");
    expect(html).toContain("Guidance upgrade with a rising trend.");
    expect(html).toContain("TB-NEG: Negative announcement");
    expect(html).toContain("Insufficient history (n &lt; 30).");
    expect(html).toContain("Stock C F1 note.");
    expect(html).toContain("(Written without AI.)");
    expect(html).toContain("2026-W43");
    expect(html).not.toContain(D);
    expect(html).not.toContain("A$1.50");
    expect(html).not.toContain("A$150.00");
    expect(html).not.toContain("A$19.00");
    expect(html).toContain("Quantity 100");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
    noLeak(html);
  });

  it("an Editor sees the same masked card", async () => {
    as("editor");
    const html = await card(encodeURIComponent(CARD_ID));
    expect(html).toContain("Decision Card: Stock C (E01)");
    noLeak(html);
  });

  it("the Owner and a user with a live grant see the real code and amounts", async () => {
    as("owner");
    const o = await card(encodeURIComponent(CARD_ID));
    expect(o).toContain("Decision Card: ZZUP (E01)");
    expect(o).toContain("ZZUP F1 note.");
    expect(o).toContain("A$1.50");
    expect(o).toContain("A$150.00");
    expect(o).toContain(D);
    as("editor");
    await grantTo("2099-01-01T00:00:00.000Z");
    expect(await card(encodeURIComponent(CARD_ID))).toContain("Decision Card: ZZUP (E01)");
  });

  it("an expired grant leaves the card masked", async () => {
    as("viewer");
    await grantTo("2020-01-01T00:00:00.000Z");
    noLeak(await card(encodeURIComponent(CARD_ID)));
  });

  it("404s an unknown card and refuses when the guard refuses", async () => {
    as("viewer");
    await expect(card("card:missing")).rejects.toThrow();
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(card(encodeURIComponent(CARD_ID))).rejects.toThrow(/403/);
  });
});
