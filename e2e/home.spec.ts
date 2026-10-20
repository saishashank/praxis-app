// M7 T11 Home in a real browser (AT-25 Home rows, AT-26 360 px and axe, AT-27 honesty, UX-012a welcome
// banner, UX-009 masking). The scenario (empty / populated / stale) comes from E2E_SCENARIO; assertions
// that only hold for populated data are guarded by the visible state.
import { expect, test } from "@playwright/test";
import {
  ROLE_LIST,
  axeAllThemes,
  axeViolations,
  expectNoHorizontalScroll,
  setTheme,
  signIn,
} from "./helpers";

for (const role of ROLE_LIST) {
  test(`${role}: Home renders its own main, the Today heading and the Simulated label`, async ({
    page,
    context,
  }) => {
    await signIn(context, role);
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await expect(page.getByText("Pretend value today")).toBeVisible();
    await expect(page.getByText("Simulated").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /buy|sell|place order/i })).toHaveCount(0);
  });

  test(`${role}: no horizontal scroll at 360 px, axe clean in dark and light`, async ({
    page,
    context,
  }) => {
    await signIn(context, role);
    await page.setViewportSize({ width: 360, height: 800 });
    for (const theme of ["dark", "light"] as const) {
      await setTheme(role, theme);
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectNoHorizontalScroll(page);
      expect(await axeViolations(page)).toEqual([]);
    }
  });
}

test("welcome banner: shown on the first visit, gone after Got it, per user", async ({
  page,
  context,
}) => {
  await signIn(context, "viewer");
  await page.goto("/");
  const banner = page.getByRole("region", { name: "Welcome to Praxis" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("A$1,200");
  await expect(banner).toContainText("A$300");
  await banner.getByRole("button", { name: "Got it, hide this" }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Welcome to Praxis" })).toHaveCount(0);
});

test("masked roles: the page text never carries a stock code from the seed (UX-009)", async ({
  page,
  context,
}) => {
  for (const role of ["editor", "viewer"] as const) {
    await signIn(context, role);
    await page.goto("/");
    const html = await page.locator("main").innerHTML();
    expect(html).not.toMatch(/\bZZ[A-Z0-9]{1,4}\b/);
    await expect(page.getByText("Company news is hidden for your role.")).toBeVisible();
  }
});

test("owner: system-health line is present", async ({ page, context }) => {
  await signIn(context, "owner");
  await page.goto("/");
  await expect(page.getByTestId("status-line")).toContainText(/All systems working|need a look/);
});

test("axe: Home has no violations in any of the six themes", async ({ page, context }) => {
  const out = await axeAllThemes(page, context, "viewer", "/");
  for (const [theme, v] of Object.entries(out)) expect(v, theme).toEqual([]);
});
