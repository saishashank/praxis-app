// AT-26 mobile (phone project, 360 x 800): no horizontal scroll on every sweep page, per role.
import { expect, test } from "@playwright/test";
import { PAGES, sweepPaths } from "./pages";
import { ROLE_LIST, expectNoHorizontalScroll, signIn } from "./helpers";

test("phone viewport is 360 wide", async ({ page }) => {
  await page.goto("/signin");
  expect(await page.evaluate(() => window.innerWidth)).toBe(360);
  await expectNoHorizontalScroll(page);
});

for (const role of ROLE_LIST) {
  test(`${role}: no horizontal scroll on any page`, async ({ page, context }) => {
    await signIn(context, role);
    const paths = new Set(sweepPaths(role));
    for (const p of PAGES) if (p.action === "public" && !p.needsData) paths.add(p.path);
    for (const path of paths) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
  });
}
