import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.describe("roles (TST-126, ROL-102a)", () => {
  test("owner sees Users, Usage and Configuration links", async ({ page, context }) => {
    await signIn(context, "owner");
    await page.goto("/");
    await expect(page.getByText("Signed in as owner")).toBeVisible();
    for (const name of ["Users & roles", "Usage", "Configuration"]) {
      await expect(page.getByRole("link", { name })).toBeVisible();
    }
  });

  for (const role of ["viewer", "editor"] as const) {
    test(`${role} has no admin links and gets the 403 page`, async ({ page, context }) => {
      await signIn(context, role);
      await page.goto("/");
      await expect(page.getByText(`Signed in as ${role}`)).toBeVisible();
      for (const name of ["Users & roles", "Usage", "Configuration"]) {
        await expect(page.getByRole("link", { name })).toHaveCount(0);
      }
      for (const p of ["/users", "/usage", "/config"]) {
        const res = await page.goto(p);
        expect(res?.status()).toBe(403);
        await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      }
    });
  }
});
