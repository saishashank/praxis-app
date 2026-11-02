// M7 T17 Reviews tab and Glossary in a real browser (AT-25 Reviews rows, AT-26 360 px and axe, UX-009
// masking, UX-080, UXN-206, UX-071b). The scenario comes from E2E_SCENARIO; the seed holds no stored
// review, so assertions about a review's content are covered by tests/review/reviewsPages.test.tsx and
// here only the states that always hold are checked (empty list, calendar, glossary, a date without a
// review).
import { expect, test } from "@playwright/test";
import { ROLE_LIST, axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";

const PAGES = [
  { path: "/reviews", h1: "Reviews" },
  { path: "/reviews?view=calendar", h1: "Reviews" },
  { path: "/reviews/glossary", h1: "Glossary" },
  { path: "/reviews/2026-01-01", h1: "Evening Review 2026-01-01" },
] as const;

for (const role of ROLE_LIST) {
  for (const p of PAGES) {
    test(`${role}: ${p.path} renders its own main and heading`, async ({ page, context }) => {
      await signIn(context, role);
      const res = await page.goto(p.path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("main")).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: p.h1 })).toBeVisible();
      await expect(page.getByRole("button", { name: /mark as read/i })).toHaveCount(0);
      if (role !== "owner") {
        const html = await page.locator("main").innerHTML();
        expect(html).not.toMatch(/\bZZ[A-Z0-9]{1,4}\b/);
      }
    });

    test(`${role}: ${p.path} has no horizontal scroll at 360 px and is axe clean in dark and light`, async ({
      page,
      context,
    }) => {
      await signIn(context, role);
      await page.setViewportSize({ width: 360, height: 800 });
      for (const theme of ["dark", "light"] as const) {
        await setTheme(role, theme);
        await page.goto(p.path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectNoHorizontalScroll(page);
        expect(await axeViolations(page)).toEqual([]);
      }
    });
  }
}

test("the list and the calendar switch by link and keep state in the URL", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/reviews");
  const view = page.getByRole("navigation", { name: "Review view" });
  await view.getByRole("link", { name: /^Calendar/ }).click();
  await expect(page).toHaveURL(/view=calendar/);
  await view.getByRole("link", { name: /^Reviews/ }).click();
  await expect(page).toHaveURL(/\/reviews$/);
});

test("the glossary search narrows the list and a term anchor exists", async ({ page, context }) => {
  await signIn(context, "viewer");
  await page.goto("/reviews/glossary?q=borrowed");
  await expect(page.getByText("Leverage").first()).toBeVisible();
  await expect(page.getByText("Cost drag")).toHaveCount(0);
  await page.goto("/reviews/glossary#simulated");
  await expect(page.locator("#simulated")).toBeVisible();
});
