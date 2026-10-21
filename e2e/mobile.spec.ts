// AT-26 mobile (phone project, 360 x 800): no horizontal scroll on every sweep page, per role.
import { expect, test } from "@playwright/test";
import { PAGES, allowedRoles, sweepPaths } from "./pages";
import { ROLE_LIST, concretePath, expectNoHorizontalScroll, signIn } from "./helpers";

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

// AT-26: every allowed page shows the bottom bar with the six tabs, and forbidden pages also fit.
for (const role of ROLE_LIST) {
  test(`${role}: bottom bar on every page, 403 page fits`, async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(context, role);
    for (const entry of PAGES) {
      const url = concretePath(entry.path, role);
      if (!url || entry.action === "public") continue;
      const allowed = allowedRoles(entry).includes(role);
      const res = await page.goto(url);
      expect(res?.status(), entry.path).toBe(allowed ? 200 : 403);
      await expectNoHorizontalScroll(page);
      if (allowed) {
        const bar = page.getByRole("navigation", { name: "Main (bottom bar)" });
        await expect(bar, entry.path).toBeVisible();
        await expect(bar.getByRole("link"), entry.path).toHaveCount(6);
        await expect(page.getByRole("main"), entry.path).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1 }), entry.path).toHaveCount(1);
      }
    }
  });
}
