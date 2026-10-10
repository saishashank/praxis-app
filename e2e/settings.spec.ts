import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("switching theme to high contrast sets data-theme after reload (UXN-280)", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/settings");
  await page.getByLabel("Theme").selectOption("high_contrast");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "high_contrast");
});
