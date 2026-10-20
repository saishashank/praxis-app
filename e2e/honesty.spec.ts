// AT-27 honesty over every page and role: each [data-money] value sits in a card, row or section that
// carries the Simulated label; no control can place a real order (PRD-001, UX-042).
import { expect, test } from "@playwright/test";
import { PAGES, allowedRoles } from "./pages";
import { ROLE_LIST, concretePath, moneyWithoutSimulated, signIn } from "./helpers";

// A control that places an order: "Buy ...", "Sell ...", "Place order". ("Switch off Buy the dip" is a strategy switch.)
const ORDER_RE = /^(buy|sell)\b|place (an )?order/i;

for (const role of ROLE_LIST) {
  test(`${role}: money has a Simulated label and no page offers an order`, async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);
    await signIn(context, role);
    for (const entry of PAGES) {
      const url = concretePath(entry.path, role);
      if (!url || entry.action === "public" || !allowedRoles(entry).includes(role)) continue;
      const res = await page.goto(url);
      expect(res?.status(), entry.path).toBe(200);
      expect(await moneyWithoutSimulated(page), `${entry.path}: money without Simulated`).toEqual(
        [],
      );
      await expect(page.getByRole("button", { name: ORDER_RE }), entry.path).toHaveCount(0);
      await expect(page.getByRole("link", { name: ORDER_RE }), entry.path).toHaveCount(0);
    }
  });
}
