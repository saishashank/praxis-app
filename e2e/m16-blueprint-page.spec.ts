// M16 WP5 / AT-59 (a)(d): the Blueprint page as the pinned Owner.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, signIn } from "./helpers";

const TABS = [
  "Platform",
  "Data",
  "Cortex pipeline",
  "Agents and schedule",
  "LLM router",
  "Email and alerts",
  "Security and roles",
  "Learning loop",
];

test("eight tabs, hover, panel, search and axe", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/blueprint");
  const tablist = page.getByRole("tablist", { name: "Blueprint views" });
  await expect(tablist.getByRole("tab")).toHaveCount(8);
  for (const name of TABS) {
    await tablist.getByRole("tab", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.locator("[data-node]").first()).toBeAttached();
  }
  await tablist.getByRole("tab", { name: "Platform", exact: true }).click();

  const node = page.locator("[data-node]").first();
  await node.hover();
  await expect(page.getByTestId("bp-summary")).toContainText(
    (await node.getAttribute("aria-label"))!.split(",")[0],
  );

  await page.getByTestId("bp-search").fill("PLT-031");
  const first = page.getByTestId("bp-results").getByRole("button").first();
  await expect(first).toBeVisible();
  await first.click();
  const panel = page.getByTestId("bp-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("bp-panel-specs")).toContainText("PLT-031");
  await expect(page.getByTestId("bp-panel-status")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

test("phone width: no sideways scroll, zoom works", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 } });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/blueprint");
  await expect(page.locator("[data-node]").first()).toBeAttached();
  await expectNoHorizontalScroll(page);
  const group = page.locator("svg > g").first();
  const before = await group.getAttribute("transform");
  await page.getByRole("button", { name: "Zoom in" }).click();
  expect(await group.getAttribute("transform")).not.toEqual(before);
  await expectNoHorizontalScroll(page);
  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});
