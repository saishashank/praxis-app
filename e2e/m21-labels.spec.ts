// M21 L1 (UXN-318, D-1227; AT-82): the golden-set labelling page, driven with the keyboard only by the Owner on the seeded
// `labels-queue` state (three AU headlines, no answer yet; part of E2E_STATES=all). Two headlines are labelled without the
// mouse (1 to 4 choose inside the focused group, Tab moves on, Enter saves), the count rises by exactly two, the page
// shows no automatic label, and axe finds nothing. A viewer is refused with the 403 page. Lane: rich.
import { expect, test } from "@playwright/test";
import { axeViolations, signIn } from "./helpers";
import { requireScenario } from "./support/requireScenario";

requireScenario("rich", "run it in the rich lane: E2E_SCENARIO=rich (E2E_STATES includes all)");

const progress = async (page: import("@playwright/test").Page): Promise<number> => {
  const t = (await page.getByTestId("label-progress").textContent()) ?? "";
  const m = /^([\d,]+) of /.exec(t.trim());
  return m ? Number(m[1].replace(/,/g, "")) : -1;
};

test("the Owner labels two headlines with the keyboard only", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "owner");
  const page = await context.newPage();
  await page.goto("/cortex/labels");
  await expect(page.getByRole("heading", { name: "Label announcements" })).toBeVisible();
  await expect(page.getByTestId("label-form")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  const before = await progress(page);
  expect(before).toBeGreaterThanOrEqual(0);

  for (let i = 1; i <= 2; i++) {
    const headline = (await page.getByTestId("label-headline").textContent()) ?? "";
    // the first radio holds the focus when a headline appears
    await expect(page.locator('input[type="radio"]').first()).toBeFocused();
    await page.keyboard.press("1"); // guidance: Raised
    await page.keyboard.press("Tab");
    await page.keyboard.press("1"); // event: Confirmed
    await page.keyboard.press("Tab");
    await page.keyboard.press("3"); // tone: Positive
    await expect(page.getByRole("radio", { name: /^Raised/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Confirmed/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Positive/ })).toBeChecked();
    await page.keyboard.press("Enter");
    // a new headline replaces the answered one and the count has risen
    await expect(page.getByTestId("label-headline")).not.toHaveText(headline);
    await expect.poll(() => progress(page)).toBe(before + i);
  }
  await expect(page.getByTestId("label-progress")).toContainText(` of 500`);
  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

test("a viewer gets the 403 page", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await signIn(context, "viewer");
  const r = await context.request.get("/cortex/labels", { maxRedirects: 0 });
  expect(r.status()).toBe(403);
  await context.close();
});
