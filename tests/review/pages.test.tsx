// @vitest-environment node
// Evening Review pages and the mark-as-read action (M5 T9; EML-036, ROL-102a, decision 29 and 34).
// /reviews/[date]: every signed-in role reads the stored review, only the Owner sees "Mark as read";
// /cards/[id]: read-only for all roles; markReviewReadAction: Owner only, insert-once, validated.
// Real migrations on a local file; the guard and the database handle are the only mocks.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { cleanupTempDbs } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const dbRef = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => dbRef.db }));

import ReviewDatePage from "@/app/(app)/reviews/[date]/page";
import { markReviewReadAction } from "@/app/(app)/reviews/[date]/actions";
import CardPage from "@/app/(app)/cards/[id]/page";
import { assembleReview, readState } from "@/lib/review/assemble";
import { APP, CARD_ID, D, MARKET, NOW, addCard, mainWorld, tradingDay } from "./helpers";

afterEach(cleanupTempDbs);

let db: Client;
const as = (role: string) =>
  requireUser.mockResolvedValue({ id: 1, email: "e@example.test", name: null, role });
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
  const { e01 } = await tradingDay(db);
  await addCard(db, e01);
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
    "%s reads the stored review but gets no Mark as read",
    async (role) => {
      as(role);
      const html = await page(D);
      expect(html).toContain("Evening Review 2026-10-19");
      expect(html).toContain("<iframe");
      expect(html).toContain('sandbox=""');
      expect(html).toContain("Not marked as read yet.");
      expect(html).not.toContain("Mark as read</button>");
    },
  );

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

  it("renders the stored card read-only for any signed-in role (encoded id)", async () => {
    as("viewer");
    const html = await card(encodeURIComponent(CARD_ID));
    expect(requireUser).toHaveBeenCalledWith("read", `/cards/${encodeURIComponent(CARD_ID)}`);
    expect(html).toContain("Decision Card: ZZUP (E01)");
    expect(html).toContain("Guidance upgrade with a rising trend.");
    expect(html).toContain("TB-NEG: Negative announcement");
    expect(html).toContain("Insufficient history (n &lt; 30).");
    expect(html).toContain("ZZUP F1 note.");
    expect(html).toContain("(Written without AI.)");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("404s an unknown card and refuses when the guard refuses", async () => {
    as("viewer");
    await expect(card("card:missing")).rejects.toThrow();
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(card(encodeURIComponent(CARD_ID))).rejects.toThrow(/403/);
  });
});
