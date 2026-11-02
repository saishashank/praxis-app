// AT-62 (a)(b), M17 WP8: Picks and Home show "Tonight's picks" and "Intraday watch" (own accent, one-line
// explainer, empty state with the last scan time, "Unrated"/"unvalidated"); My alerts and Settings > Alerts
// render; masking holds for Editor and Viewer; all of it at 1280 and 375 px in the six themes with axe clean
// and no horizontal scroll. Reuses the M8.1 theme walk helpers (setTheme, signIn, axeViolations).
// The E2E seed may have no candidates: the empty state is then what is checked.
import { expect, test } from "@playwright/test";
import {
  axeViolations,
  CODE_RE,
  expectNoHorizontalScroll,
  mainText,
  ROLE_LIST,
  setTheme,
  signIn,
  THEMES,
} from "./helpers";
import { ensureRich } from "./seed/rich";

test.describe.configure({ timeout: 900_000 });
test.beforeAll(async () => {
  await ensureRich();
});

const SIZES = [1280, 375] as const;
const PAGES = ["/picks", "/", "/alerts", "/settings/alerts"] as const;

for (const role of ROLE_LIST) {
  for (const width of SIZES) {
    test(`picks sections: ${role} at ${width}px in six themes`, async ({ page, context }) => {
      await signIn(context, role);
      await page.setViewportSize({ width, height: 800 });
      for (const theme of THEMES) {
        await setTheme(role, theme);
        for (const path of PAGES) {
          await page.goto(path);
          const text = await mainText(page);
          if (path === "/picks" || path === "/") {
            await expect(
              page.getByRole("heading", { name: "Tonight's picks" }).first(),
            ).toBeVisible();
            await expect(page.getByTestId("intraday-section")).toBeVisible();
            expect(text).toMatch(/Intraday watch/);
            expect(text).toMatch(/delayed/);
            expect(text).not.toMatch(/real[- ]?time/i);
            const unrated = await page.getByTestId("unrated").count();
            if (unrated === 0) await expect(page.getByTestId("intraday-empty")).toBeVisible();
          }
          if (path === "/settings/alerts") {
            await expect(page.getByTestId("daily-cap")).toBeVisible();
            await expect(page.getByTestId("delay-help")).toContainText("delayed");
          }
          if (role !== "owner") expect(text, `${role} ${path} ${theme}`).not.toMatch(CODE_RE);
          await expectNoHorizontalScroll(page);
          const bad = await axeViolations(page);
          expect(bad, `${role} ${width} ${theme} ${path}`).toEqual([]);
        }
      }
    });
  }
}
