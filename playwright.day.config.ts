// Playwright for the CI RECORDED DAY (M18 OPS-107 / D-965; was playwright.staging.config.ts, M8 T12,
// TST-132, AT-28). Used by scripts/e2e-day/recorded-day.mjs, which starts the production build on
// loopback and passes its address as APP_BASE_URL; the retained dispatch-only staging workflows reach
// it through the one-line re-export in playwright.staging.config.ts. There is no web server here:
// the target is APP_BASE_URL. Read-only checks of recorded data. SEC-110: no trace, screenshot or video
// is kept (they can hold URLs and page data), the reporter prints test titles only, and nothing is
// uploaded as an artifact.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.APP_BASE_URL;
if (!baseURL) throw new Error("APP_BASE_URL is not set");

export default defineConfig({
  testDir: "./e2e-day",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 1,
  reporter: [["line"]],
  timeout: 60_000,
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
});
