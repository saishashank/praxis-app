import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("switching theme to high contrast sets data-theme after reload (UXN-280)", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: "High contrast" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "high_contrast");
});

test("Motion off sets data-motion on the html element (UXN-281)", async ({ page, context }) => {
  await signIn(context, "editor");
  await page.goto("/settings/appearance");
  await page.getByLabel("Animation").selectOption("off");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "off");
});
