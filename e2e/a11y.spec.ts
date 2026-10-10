// TST-126 accessibility: axe (WCAG 2.2 AA tags) on the signed-in and sign-in pages, dark + light.
import { expect, test } from "@playwright/test";
import { axeViolations, setTheme, signIn } from "./helpers";

const PAGES = ["/", "/health", "/users", "/config", "/settings"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`axe ${theme}`, () => {
    test(`/signin`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/signin");
      expect(await axeViolations(page)).toEqual([]);
    });

    for (const path of PAGES) {
      test(path, async ({ page, context }) => {
        await setTheme("owner", theme);
        await signIn(context, "owner");
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  });
}
