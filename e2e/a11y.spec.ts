// TST-126 accessibility: axe (WCAG 2.2 AA tags) on the signed-in and sign-in pages, dark + light.
import { expect, test } from "@playwright/test";
import { PAGES, allowedRoles } from "./pages";
import {
  ROLE_LIST,
  THEMES,
  axeAllThemes,
  axeViolations,
  concretePath,
  setTheme,
  signIn,
} from "./helpers";

const SHELL_PAGES = ["/", "/health", "/users", "/config", "/settings"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`axe ${theme}`, () => {
    test(`/signin`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto("/signin");
      expect(await axeViolations(page)).toEqual([]);
    });

    for (const path of SHELL_PAGES) {
      test(path, async ({ page, context }) => {
        await setTheme("owner", theme);
        await signIn(context, "owner");
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        expect(await axeViolations(page)).toEqual([]);
      });
    }
  });
}

// AT-26 a11y over the whole registry: every allowed page x role x {dark, light}, then the six tab
// pages in all six themes. Forbidden pages are checked too (the 403 page is a page).

for (const role of ROLE_LIST) {
  test(`axe all pages, ${role}, dark and light`, async ({ page, context }) => {
    test.setTimeout(480_000);
    await signIn(context, role);
    const failures: Record<string, unknown> = {};
    for (const theme of ["dark", "light"] as const) {
      await setTheme(role, theme);
      for (const entry of PAGES) {
        const url = concretePath(entry.path, role);
        if (!url || entry.action === "public") continue;
        const res = await page.goto(url);
        const want = allowedRoles(entry).includes(role) ? 200 : 403;
        expect(res?.status(), `${theme} ${entry.path}`).toBe(want);
        if (want === 200) {
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        }
        const v = await axeViolations(page);
        if (v.length) failures[`${theme} ${entry.path}`] = v;
      }
    }
    expect(failures).toEqual({});
  });
}

test("axe public pages, dark and light", async ({ page }) => {
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const entry of PAGES.filter((p) => p.action === "public")) {
      await page.goto(entry.path);
      expect(await axeViolations(page), `${theme} ${entry.path}`).toEqual([]);
    }
  }
});

test("axe: the six tab pages in all six themes (viewer)", async ({ page, context }) => {
  test.setTimeout(480_000);
  for (const path of ["/", "/picks", "/market", "/strategies", "/news", "/reviews"]) {
    const out = await axeAllThemes(page, context, "viewer", path, THEMES);
    for (const [theme, v] of Object.entries(out)) expect(v, `${path} ${theme}`).toEqual([]);
  }
});
