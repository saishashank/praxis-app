// AT-26 keyboard: on every signed-in page the skip link is the first Tab stop, the page has no
// positive tabindex, and the skip link moves focus to the content (UXN-038).
import { expect, test } from "@playwright/test";
import { PAGES, allowedRoles } from "./pages";
import { ROLE_LIST, concretePath, signIn } from "./helpers";

for (const role of ROLE_LIST) {
  test(`${role}: skip link first, no positive tabindex, on every page`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await signIn(context, role);
    for (const entry of PAGES) {
      const url = concretePath(entry.path, role);
      if (!url || entry.action === "public" || !allowedRoles(entry).includes(role)) continue;
      await page.goto(url);
      expect(
        await page.evaluate(
          () =>
            Array.from(document.querySelectorAll("[tabindex]")).filter(
              (e) => Number(e.getAttribute("tabindex")) > 0,
            ).length,
        ),
        `${entry.path}: positive tabindex`,
      ).toBe(0);
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to main content" }),
        `${entry.path}: skip link first`,
      ).toBeFocused();
    }
  });
}
