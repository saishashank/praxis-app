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

test("Settings is one page: Sign out visible, a row opens a sheet with one Save and a toast (UXR-027, UXR-043, UXR-046)", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toHaveCount(0);
  await page.getByRole("link", { name: /^Theme/ }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Save", exact: true })).toHaveCount(1);
  await sheet.getByRole("radio", { name: /Midnight/ }).click();
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
});

test("Settings has no horizontal overflow at 375 px", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(context, "viewer");
  await page.goto("/settings");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
