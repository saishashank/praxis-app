// M11-lite WP6 (AGT-133a, UXN-287, ROL-107; D-492/D-497/D-498): the steelman on the Decision Card and the
// Owner's rule suggestions on /review. Needs the "rich" scenario (E2E_SCENARIO=rich): seed/steelman.ts
// adds one pack with two points a side and one open suggestion. The Owner sees both; an Editor and a
// Viewer get the card section without codes and a 403 on /review; the card fits a phone with the body
// collapsed; axe is clean.
import { expect, test } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";
import { BEAR_TEXT, ensureSteelman } from "./seed/steelman";

test.skip(process.env.E2E_SCENARIO !== "rich", "needs E2E_SCENARIO=rich");
test.describe.configure({ timeout: 300_000 });
test.beforeAll(async () => {
  cardPath = `/cards/${encodeURIComponent(await ensureSteelman())}`;
});

let cardPath = "";

test("owner: two lists, evidence chips jump to the cited rows, caption says AI-written", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto(cardPath);
  const box = page.getByTestId("steelman-wide");
  await expect(box.getByRole("heading", { name: "Strongest case for" })).toBeVisible();
  await expect(box.getByRole("heading", { name: "Strongest case against" })).toBeVisible();
  await expect(page.getByTestId("steelman")).toContainText("AI-written");
  await expect(page.getByTestId("steelman")).toContainText("Not advice; not a forecast.");
  await box.locator('a[href="#ev-E01"]').first().click();
  await expect(page).toHaveURL(/#ev-E01$/);
  await expect(box.locator("#ev-E01")).toBeVisible();
});

test("owner: /review lists the suggestion with the rule editor link; Dismiss removes it", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.goto("/review");
  const item = page.getByTestId("steelman-suggestion").first();
  await expect(item).toContainText(BEAR_TEXT);
  await expect(item.getByRole("link", { name: "Open rule editor" })).toHaveAttribute(
    "href",
    /\/reviews\/learned\/families\/F\d/,
  );
  await item.getByRole("button", { name: /^Dismiss/ }).click();
  await expect(page.getByTestId("steelman-suggestion")).toHaveCount(0);
});

for (const role of ["editor", "viewer"] as const) {
  test(`${role}: /review is refused and shows no suggestion`, async ({ page, context }) => {
    await signIn(context, role);
    const res = await page.goto("/review");
    expect(res?.status()).toBe(403);
    await expect(page.getByTestId("steelman-suggestion")).toHaveCount(0);
  });
}

test("phone: the body is collapsed in a details element, no horizontal scroll, axe clean", async ({
  page,
  context,
}) => {
  await signIn(context, "owner");
  await page.setViewportSize({ width: 360, height: 800 });
  for (const theme of ["dark", "light"] as const) {
    await setTheme("owner", theme);
    await page.goto(cardPath);
    const d = page.getByTestId("steelman-narrow");
    await expect(d).toBeVisible();
    expect(await d.evaluate((e) => (e as HTMLDetailsElement).open)).toBe(false);
    await expect(page.getByTestId("steelman-wide")).toBeHidden();
    await expectNoHorizontalScroll(page);
    expect(await axeViolations(page)).toEqual([]);
  }
});
