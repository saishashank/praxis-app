// TST-127 / UXN-284: screenshots of every sweep page, dark and light, as Owner. Only runs in the
// `screens` project (E2E_SCREENS=1). Output goes to test-results/screens for the Opus review;
// baselines live in the private fixtures repo and are never committed here.
import { test } from "@playwright/test";
import { sweepPaths } from "./pages";
import { setTheme, signIn } from "./helpers";

for (const theme of ["dark", "light"] as const) {
  test(`screens ${theme}`, async ({ page, context }) => {
    await setTheme("owner", theme);
    await signIn(context, "owner");
    for (const path of sweepPaths("owner")) {
      await page.goto(path);
      const name = path === "/" ? "home" : path.replace(/^\//, "").replace(/\//g, "_");
      await page.screenshot({ path: `test-results/screens/${name}-${theme}.png`, fullPage: true });
    }
  });
}
