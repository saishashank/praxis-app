// M14 WP8 (D-251, AT-02, O-54): the Robustness section of one strategy. Needs the "rich" scenario
// (E2E_SCENARIO=rich): E01 has stored rows (seed/m14.ts), E02 has none. Owner and Editor see the
// section, labelled "descriptive — not a finding"; the Editor sees no setting, ranking or family
// names; the Viewer sees no section; an unmeasured strategy says "Not measured yet"; axe is clean.
import { expect, test } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";
import { ensureM14 } from "./seed/m14";

test.skip(process.env.E2E_SCENARIO !== "rich", "needs E2E_SCENARIO=rich");
test.describe.configure({ timeout: 300_000 });
test.beforeAll(async () => {
  await ensureM14();
});

const section = (page: import("@playwright/test").Page) => page.locator("[data-robustness]");

test("owner sees every table with names, and the not-a-finding label", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/strategies/E01");
  const s = section(page);
  await expect(s).toBeVisible();
  await expect(s.getByRole("heading", { name: "Robustness" })).toBeVisible();
  await expect(s.locator("[data-robustness-label]")).toContainText("descriptive — not a finding");
  await expect(s).toContainText("f1_secret_key_down");
  await expect(s).toContainText("secretrank");
  await expect(s.locator("[data-fragile]")).toBeVisible();
  await expect(s.locator("[data-min-btl]")).toContainText("too short");
  await expect(s.locator("[data-error-budget]")).toContainText("0.59%");
  expect(await axeViolations(page)).toEqual([]);
});

test("editor sees the section but no setting, ranking, family or version names", async ({
  page,
  context,
}) => {
  await signIn(context, "editor");
  await page.goto("/strategies/E01");
  const s = section(page);
  await expect(s).toBeVisible();
  await expect(s).toContainText("Setting 1");
  await expect(s).toContainText("Ranking 1");
  const text = (await s.innerText()).toLowerCase();
  for (const leak of ["f1_secret", "secretrank", "e01", "au:f1"]) expect(text).not.toContain(leak);
  expect(await axeViolations(page)).toEqual([]);
});

test("viewer does not see the section", async ({ page, context }) => {
  await signIn(context, "viewer");
  await page.goto("/strategies/E01");
  await expect(page.getByRole("heading", { name: "Past rounds" })).toBeVisible();
  await expect(section(page)).toHaveCount(0);
});

test("a strategy with nothing stored says Not measured yet", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.goto("/strategies/E02");
  const s = section(page);
  await expect(s).toBeVisible();
  await expect(s).toContainText("Not measured yet");
  await expect(s.locator("[data-fragile]")).toHaveCount(0);
});

test("the section fits a phone without sideways scrolling", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/strategies/E01");
  await expect(section(page)).toBeVisible();
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});
