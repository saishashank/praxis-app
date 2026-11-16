// M21 C7 (UXN-062, UXN-154, UXN-255, D-1201; AT-82): the three accepted presentation items on the rich seed
// (six strategies E01..E06, one open position held by E01, one finished round each for E03 and E04, matched
// control rows). Lane: rich (E2E_STATES includes "all"). Axe at phone and desktop width.
import { expect, test } from "@playwright/test";
import { CODE_RE, axeViolations, expectNoHorizontalScroll, signIn, type Role } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich");

const WIDTHS = [
  { name: "phone", width: 375, height: 800 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

async function open(
  browser: import("@playwright/test").Browser,
  baseURL: string | undefined,
  role: Role,
) {
  const context = await browser.newContext({ baseURL });
  await signIn(context, role);
  return { context, page: await context.newPage() };
}

test("Leaderboard: the factual card sits above Matched controls and says it in words", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await open(browser, baseURL, "owner");
  await page.goto("/strategies/leaderboard");
  const card = page.getByTestId("controls-summary");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(
    /^Best strategy: .+, [+\-−]?\d[\d.,]*% per finished round; matched controls: /,
  );
  expect((await card.innerText()).match(/\b[EFC]\d{1,2}\b/)).toBeNull();
  // above the table: the card comes before the "Matched controls" caption in the document
  const before = await page.evaluate(() => {
    const c = document.querySelector("[data-testid=controls-summary]");
    const t = [...document.querySelectorAll("table caption")].find((x) =>
      /Matched controls/.test(x.textContent ?? ""),
    );
    return !!c && !!t && !!(c.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/strategies/leaderboard");
    expect(await axeViolations(page), w.name).toEqual([]);
    if (w.name === "phone") await expectNoHorizontalScroll(page);
  }
  await context.close();
});

test("Risk: the concentration chart has a label, a legend and a table; a viewer sees no code", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await open(browser, baseURL, "viewer");
  await page.goto("/strategies/risk");
  const chart = page.locator("[data-chart]");
  await expect(chart).toHaveCount(1);
  await expect(chart).toHaveAttribute("data-chart", /^(donut|treemap)$/);
  await expect(chart.getByRole("img")).toHaveAttribute("aria-label", /of how much of all value/);
  await expect(chart.getByRole("table", { name: "Share of all value by stock" })).toHaveCount(1);
  const text =
    (await chart.innerText()) + (await chart.getByRole("img").getAttribute("aria-label"));
  expect(text).not.toMatch(CODE_RE);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/strategies/risk");
    expect(await axeViolations(page), w.name).toEqual([]);
    if (w.name === "phone") await expectNoHorizontalScroll(page);
  }
  await context.close();
});

test("Strategies: family groups open and close and every tile stays on the page", async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await open(browser, baseURL, "owner");
  await page.goto("/strategies");
  const tiles = page.locator("[data-strategy-tile]");
  const groups = page.locator("details[data-family-group]");
  const all = page.locator("section", {
    has: page.getByRole("heading", { name: "All strategies" }),
  });
  const before = await all.locator("[data-strategy-tile]").count();
  expect(before).toBe(6);
  await expect(groups).toHaveCount(6);
  for (let i = 0; i < 6; i += 1) await expect(groups.nth(i)).not.toHaveAttribute("open", "");
  const total = await tiles.count();
  // open every group, then close every group: the grid never changes
  for (let i = 0; i < 6; i += 1) await groups.nth(i).locator("summary").click();
  for (let i = 0; i < 6; i += 1) await expect(groups.nth(i)).toHaveAttribute("open", "");
  await expect(all.locator("[data-strategy-tile]")).toHaveCount(before);
  await expect(tiles).toHaveCount(total);
  for (let i = 0; i < 6; i += 1) await groups.nth(i).locator("summary").click();
  for (let i = 0; i < 6; i += 1) await expect(groups.nth(i)).not.toHaveAttribute("open", "");
  await expect(all.locator("[data-strategy-tile]")).toHaveCount(before);
  await expect(tiles).toHaveCount(total);
  expect(await groups.first().innerText()).not.toMatch(/\bF\d\b/);
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.goto("/strategies");
    for (let i = 0; i < 6; i += 1)
      await page.locator("details[data-family-group] summary").nth(i).click();
    expect(await axeViolations(page), w.name).toEqual([]);
    if (w.name === "phone") await expectNoHorizontalScroll(page);
  }
  await context.close();
});
