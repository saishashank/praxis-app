// M15 P4 (CTX-071, CTX-073, ROL-107, D-295): the Cortex page. Needs the "rich" scenario
// (E2E_SCENARIO=rich): seed/m15.ts adds one night, one map, one angle, one allowed strategy, a
// placebo and NAV-at-risk result and two abstains. The Owner sees every section with names; the
// Editor and Viewer see numbered strategies and angles; the page fits a phone; axe is clean in the
// themes the other specs use.
import { expect, test } from "@playwright/test";
import { axeViolations, setTheme, signIn } from "./helpers";
import { ensureM15 } from "./seed/m15";

test.skip(process.env.E2E_SCENARIO !== "rich", "needs E2E_SCENARIO=rich");
test.describe.configure({ timeout: 300_000 });
test.beforeAll(async () => {
  await ensureM15();
});

const SECTIONS = [
  "passports",
  "ledger",
  "families",
  "placebo",
  "nav",
  "abstain",
  "sector",
  "cold-start",
  "opinion",
  "ticks",
  "controls",
] as const;

test("owner sees every section, the live-books label and the names", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.goto("/cortex");
  await expect(page.getByRole("heading", { level: 1, name: "Cortex" })).toBeVisible();
  await expect(page.locator("[data-cortex-label]")).toContainText("Live books, matched settlement");
  for (const id of SECTIONS) {
    await expect(page.locator(`[data-cortex-section="${id}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-cortex-section="passports"]')).toContainText("zz_secret_angle");
  await expect(page.locator('[data-cortex-section="families"]')).toContainText("F1");
  await expect(page.locator("[data-placebo]")).toContainText("Passed");
  await expect(page.locator("[data-nav-at-risk]")).toContainText("4.2");
  await expect(page.locator('[data-cortex-section="abstain"]')).toContainText("2 book-nights");
  await expect(page.locator("[data-luck]")).toContainText("by luck alone");
  await expect(page.locator("[data-owner-controls]")).toBeVisible();
  await expect(page.locator("[data-cortex]")).toContainText("Melbourne time");
  // Empty parts say so, never zero.
  await expect(page.locator('[data-cortex-section="sector"]')).toContainText("Not measured yet");
  await expect(page.locator('[data-cortex-section="opinion"]')).toContainText("Not measured yet");
});

for (const role of ["editor", "viewer"] as const) {
  test(`${role} sees numbered strategies and angles and no controls`, async ({ page, context }) => {
    await signIn(context, role);
    await page.goto("/cortex");
    const main = page.locator("[data-cortex]");
    await expect(main).toBeVisible();
    await expect(main).toContainText("Angle 1");
    await expect(main).toContainText("Strategy 1");
    const text = (await main.innerText()).toLowerCase();
    for (const leak of ["zz_secret_angle", "trend breakout"]) expect(text).not.toContain(leak);
    await expect(page.locator("[data-owner-controls]")).toHaveCount(0);
    await expect(main).toContainText("Only the Owner can change Cortex settings");
  });
}

test("the page fits a phone without sideways scrolling", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/cortex");
  await expect(page.locator("[data-cortex]")).toBeVisible();
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});

for (const theme of ["dark", "light"] as const) {
  test(`axe is clean in the ${theme} theme (owner and viewer)`, async ({ page, context }) => {
    for (const role of ["owner", "viewer"] as const) {
      await setTheme(role, theme);
      await signIn(context, role);
      await page.goto("/cortex");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await axeViolations(page), `${role} ${theme}`).toEqual([]);
    }
  });
}
