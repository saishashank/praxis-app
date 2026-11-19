// M21 C5 / AT-82 (UXN-320 c, D-1202, D-1315): emulating the device colour scheme looks the same as choosing the theme
// in the Settings control. A signed-in user on "Match device" (system) under emulated `dark` renders the same
// computed token set as the same user with "Dark" chosen through Settings > Appearance, and likewise for `light`,
// at 1280 and 375 px. Each of the six themes chosen through the control is axe clean. One pass runs at text size
// "large" on 375 px.
import { expect, test, type Page } from "@playwright/test";
import { THEMES, axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";

test.describe.configure({ timeout: 300_000 });

const SIZES = [1280, 375] as const;
const LABEL: Record<(typeof THEMES)[number], string> = {
  dark: "Dark",
  light: "Light",
  system: "Match device",
  midnight: "Midnight",
  dim: "Dim",
  high_contrast: "High contrast",
};
const TOKENS = [
  "--color-bg",
  "--color-surface",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-brand-b-fill",
  "--color-positive-fill",
  "--color-negative-fill",
  "--band-info",
  "--band-warn",
  "--band-stale",
  "--band-neutral",
];

async function look(page: Page): Promise<{
  tokens: Record<string, string>;
  body: { color: string; background: string };
}> {
  return page.evaluate((names) => {
    const root = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    return {
      tokens: Object.fromEntries(names.map((n) => [n, root.getPropertyValue(n).trim()])),
      body: { color: body.color, background: body.backgroundColor },
    };
  }, TOKENS);
}

/** Choose a theme through the Settings control (the radio the user sees), save it, and return to Settings. */
async function chooseInSettings(page: Page, theme: (typeof THEMES)[number]): Promise<void> {
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: new RegExp(`^${LABEL[theme]}`) }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.goto("/settings");
}

for (const width of SIZES) {
  for (const scheme of ["dark", "light"] as const) {
    test(`viewer: system under emulated ${scheme} equals ${scheme} chosen in Settings at ${width} px`, async ({
      page,
      context,
    }) => {
      await signIn(context, "viewer");
      await page.setViewportSize({ width, height: 900 });

      await setTheme("viewer", "system");
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/settings");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      const emulated = await look(page);

      await chooseInSettings(page, scheme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      const chosen = await look(page);

      expect(emulated).toEqual(chosen);
      for (const v of Object.values(chosen.tokens)) expect(v).not.toBe("");
    });
  }
}

for (const theme of THEMES) {
  test(`viewer: ${theme} chosen through the Settings control is axe clean at 1280 and 375 px`, async ({
    page,
    context,
  }) => {
    await signIn(context, "viewer");
    await setTheme("viewer", "dark");
    for (const width of SIZES) {
      await page.setViewportSize({ width, height: 900 });
      await chooseInSettings(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await axeViolations(page), `${theme} at ${width}`).toEqual([]);
      if (width === 375) await expectNoHorizontalScroll(page);
    }
  });
}

test("viewer: text size large on 375 px keeps the emulated dark look and stays axe clean", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.setViewportSize({ width: 375, height: 812 });
  await setTheme("viewer", "system");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/appearance");
  await page.getByLabel("Text size", { exact: true }).selectOption("large");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "large");
  const emulated = await look(page);
  await chooseInSettings(page, "dark");
  expect(await look(page)).toEqual(emulated);
  expect(await axeViolations(page)).toEqual([]);
  await expectNoHorizontalScroll(page);
});
