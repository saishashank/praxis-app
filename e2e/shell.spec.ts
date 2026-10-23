// M7 T9 app shell in a real browser (TST-126): the six tabs fit the bottom bar at 360 px (UXN-270 "More"
// is only needed if they do not), no horizontal scroll, menus by keyboard, theme cycle without reload,
// axe on the shell. Runs in the desktop project; the phone width is set per test.
import { expect, test } from "@playwright/test";
import { ROLE_LIST, axeViolations, expectNoHorizontalScroll, signIn } from "./helpers";

const SIX = ["Home", "Picks", "Market", "Strategies", "News", "Reviews"];

test("360 px: bottom bar shows all six labels unclipped, so no More menu is needed", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await signIn(context, "owner");
  await page.goto("/settings");
  const bar = page.getByRole("navigation", { name: "Main (bottom bar)" });
  await expect(bar).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeHidden();
  const links = bar.getByRole("link");
  await expect(links).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    const link = links.nth(i);
    await expect(link).toContainText(SIX[i]!);
    const m = await link.evaluate((a) => {
      const label = a.querySelector("span") as HTMLElement;
      const r = a.getBoundingClientRect();
      const l = label.getBoundingClientRect();
      return { fits: l.left >= r.left - 0.5 && l.right <= r.right + 0.5, h: r.height, w: r.width };
    });
    expect(m.fits, SIX[i]).toBe(true);
    expect(m.h).toBeGreaterThanOrEqual(48);
  }
  await expectNoHorizontalScroll(page);
  await page.goto("/"); // Home (T11) also fits at 360 px
  await expectNoHorizontalScroll(page);
  // the page content is not hidden behind the bar
  const footer = page.getByRole("contentinfo");
  await footer.scrollIntoViewIfNeeded();
  const [fb, bb] = await Promise.all([footer.boundingBox(), bar.boundingBox()]);
  expect(fb!.y + fb!.height).toBeLessThanOrEqual(bb!.y + 1);
});

test("desktop: tab row in the header, no bottom bar", async ({ page, context }) => {
  await signIn(context, "viewer");
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main (bottom bar)" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Home" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
});

for (const role of ROLE_LIST) {
  test(`${role}: gear menu by keyboard, role-aware items`, async ({ page, context }) => {
    await signIn(context, role);
    await page.goto("/");
    const gear = page.getByRole("button", { name: "Account and settings menu" });
    await gear.focus();
    await page.keyboard.press("Enter");
    await expect(gear).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator(`#${await gear.getAttribute("aria-controls")}`);
    const items = await panel.getByRole("link").allTextContents();
    expect(items).toEqual(
      role === "owner"
        ? [
            "Settings",
            "System health",
            "Usage",
            "Ops checklist",
            "Users & roles",
            "Audit log",
            "Configuration",
            "Data review",
          ]
        : ["Settings", "System health"],
    );
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await expect(gear).toHaveAttribute("aria-expanded", "false");
    await expect(gear).toBeFocused();
  });
}

test("skip link is the first Tab stop and moves focus to the page content", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#content")).toBeFocused();
});

test("theme shortcut changes the theme without a full reload", async ({ page, context }) => {
  await signIn(context, "editor");
  await page.goto("/");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  await page.getByRole("button", { name: /^Appearance:/ }).click();
  await expect(html).not.toHaveAttribute("data-theme", before!);
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
});

test("axe: no violations on the shell, phone and desktop, gear menu open", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/health");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Account and settings menu" }).click();
  expect(await axeViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/settings");
  expect(await axeViolations(page)).toEqual([]);
});
