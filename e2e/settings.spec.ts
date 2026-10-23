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

test("Settings is one page: Sign out visible, a row opens its form in place (UXR-027, UXR-004)", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
  const look = page.locator("details", { hasText: "Look" });
  await look.locator("summary").click();
  await look.getByRole("radio", { name: "Midnight" }).check();
  await look.getByRole("button", { name: "Save", exact: true }).click();
  await expect(look.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
});
