// M21 C1 / AT-82 (UXN-320 a, D-1203, F): the stored Evening Review in its frame. The plain e2e seed holds no stored
// review, so this runs on the `review-stored` state (E2E_STATES=review-stored, or "all"; e2e/seed/states.mjs) and
// skips itself when the page has no frame. Checks: the sandbox is allow-same-origin and nothing else, no script runs
// in the frame, the frame is as tall as its content (no blank band below it) at 1280 and 375 px, and axe is clean.
import { expect, test, type Page } from "@playwright/test";
import { axeViolations, expectNoHorizontalScroll, setTheme, signIn } from "./helpers";

const SIZES = [1280, 375] as const;

async function openStoredReview(page: Page): Promise<boolean> {
  await page.goto("/reviews");
  const link = page.locator('main a[href^="/reviews/20"]').first();
  if ((await link.count()) === 0) return false;
  await link.click();
  await page.waitForURL(/\/reviews\/20\d{2}-\d{2}-\d{2}/);
  return (await page.locator("iframe[srcdoc]").count()) > 0;
}

for (const width of SIZES) {
  test(`owner: the review frame is sized to its content at ${width} px, sandboxed, with no script`, async ({
    page,
    context,
  }) => {
    await signIn(context, "owner");
    await page.setViewportSize({ width, height: 900 });
    test.skip(
      !(await openStoredReview(page)),
      "no stored review: run with E2E_STATES=review-stored",
    );
    const frame = page.locator("iframe[srcdoc]").first();
    await expect(frame).toBeVisible();

    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    expect(sandbox.split(/\s+/).filter(Boolean)).toEqual(["allow-same-origin"]);

    // The parent measures the frame document on load; wait until it has set the exact height.
    await expect
      .poll(async () =>
        frame.evaluate((el: HTMLIFrameElement) => {
          const doc = el.contentDocument;
          if (doc === null) return 1e9;
          // A short frame reports its own height: compare with the content's own box instead.
          return Math.abs(
            el.clientHeight - Math.ceil(doc.documentElement.getBoundingClientRect().height),
          );
        }),
      )
      .toBeLessThanOrEqual(4);

    const { scripts, handlers } = await frame.evaluate((el: HTMLIFrameElement) => {
      const doc = el.contentDocument!;
      return {
        scripts: doc.querySelectorAll("script").length,
        handlers: [...doc.querySelectorAll("*")].filter((e) =>
          e.getAttributeNames().some((a) => a.startsWith("on")),
        ).length,
      };
    });
    expect(scripts).toBe(0);
    expect(handlers).toBe(0);

    await expectNoHorizontalScroll(page);
  });

  test(`owner: the review page is axe clean in dark and light at ${width} px`, async ({
    page,
    context,
  }) => {
    await signIn(context, "owner");
    await page.setViewportSize({ width, height: 900 });
    test.skip(
      !(await openStoredReview(page)),
      "no stored review: run with E2E_STATES=review-stored",
    );
    const path = new URL(page.url()).pathname;
    for (const theme of ["dark", "light"] as const) {
      await setTheme("owner", theme);
      await page.goto(path);
      await expect(page.locator("iframe[srcdoc]").first()).toBeVisible();
      expect(await axeViolations(page), `${path} ${theme} ${width}`).toEqual([]);
    }
  });
}
