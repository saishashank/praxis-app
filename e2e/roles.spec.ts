import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// The gear menu in the app shell (M7 T9) holds the admin links; Home no longer lists them (T11).
async function gearLinks(page: import("@playwright/test").Page): Promise<string[]> {
  const gear = page.getByRole("button", { name: "Account and settings menu" });
  await gear.click();
  return page
    .locator(`#${await gear.getAttribute("aria-controls")}`)
    .getByRole("link")
    .allTextContents();
}

test.describe("roles (TST-126, ROL-102a)", () => {
  test("owner sees Users, Usage and Configuration links", async ({ page, context }) => {
    await signIn(context, "owner");
    await page.goto("/");
    const links = await gearLinks(page);
    for (const name of ["Users & roles", "Usage", "Configuration"]) expect(links).toContain(name);
  });

  for (const role of ["viewer", "editor"] as const) {
    test(`${role} has no admin links and gets the 403 page`, async ({ page, context }) => {
      await signIn(context, role);
      await page.goto("/");
      const links = await gearLinks(page);
      for (const name of ["Users & roles", "Usage", "Configuration"]) {
        expect(links).not.toContain(name);
      }
      for (const p of ["/users", "/usage", "/config"]) {
        const res = await page.goto(p);
        expect(res?.status()).toBe(403);
        await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      }
    });
  }
});
