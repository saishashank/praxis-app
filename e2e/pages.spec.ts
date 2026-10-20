// AT-25 page coverage (M7 design section 5): every page in the registry x {owner, editor, viewer} plus
// the signed-out redirect. Allowed pages render their own <main> and one h1; forbidden pages give the
// 403 page; masked roles (Editor, Viewer) see no stock codes, company names or exact dates (UX-009).
// Pages that need a seeded row are opened only when concretePath() knows one (populated scenario).
import { expect, test } from "@playwright/test";
import { PAGES, allowedRoles, GUARDED } from "./pages";
import {
  CODE_RE,
  EXACT_DATE_RE,
  NAME_RE,
  ROLE_LIST,
  concretePath,
  mainText,
  signIn,
} from "./helpers";

// Pages that show a data-as-of date or run times, not a trade date: /market prints the date of its latest
// end-of-day data (public company data, decision 21); the health and settings pages print run times;
// the legal pages print their last-updated date.
const DATED_OK = [
  "/privacy",
  "/terms",
  "/market",
  "/health",
  "/settings",
  "/settings/about",
  "/settings/region",
];

for (const role of ROLE_LIST) {
  test.describe(`${role}`, () => {
    for (const entry of PAGES) {
      const url = concretePath(entry.path, role);
      if (!url) continue;
      const allowed = allowedRoles(entry).includes(role);
      test(`${entry.path} ${allowed ? "renders" : "is forbidden"}`, async ({ page, context }) => {
        await signIn(context, role);
        const res = await page.goto(url);
        if (!allowed) {
          expect(res?.status()).toBe(403);
          await expect(page.getByRole("heading", { level: 1, name: "Forbidden" })).toBeVisible();
          await expect(page.getByRole("main")).toHaveCount(1);
          return;
        }
        expect(res?.status()).toBe(200);
        await expect(page.getByRole("main")).toHaveCount(1);
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toHaveCount(1);
        if (entry.h1) await expect(h1).toHaveText(entry.h1);
        if (role !== "owner") {
          const text = await mainText(page);
          expect(text, "stock code").not.toMatch(CODE_RE);
          expect(text, "company name").not.toMatch(NAME_RE);
          // Admin-only data (run times, audit rows) never reaches these roles; every other page
          // must keep exact dates out of the text. The only dated pages are the health times.
          if (!DATED_OK.includes(entry.path)) {
            expect(text, "exact date").not.toMatch(EXACT_DATE_RE);
          }
          const html = await page.content();
          expect(html, "stock code in HTML").not.toMatch(CODE_RE);
          expect(html, "company name in HTML").not.toMatch(NAME_RE);
        }
      });
    }
  });
}

test.describe("signed out", () => {
  for (const entry of GUARDED) {
    test(`${entry.path} redirects to /signin`, async ({ page }) => {
      const url = entry.path.includes("[") ? entry.path.replace(/\[[^\]]+\]/g, "x") : entry.path;
      await page.goto(url);
      await expect(page).toHaveURL(/\/signin\?callbackUrl=/);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }
});

test("public pages render their own main and h1 without a session", async ({ page }) => {
  for (const entry of PAGES.filter((p) => p.action === "public")) {
    const res = await page.goto(entry.path);
    expect(res?.status(), entry.path).toBe(200);
    await expect(page.getByRole("main"), entry.path).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 }), entry.path).toHaveText(entry.h1!);
  }
});
