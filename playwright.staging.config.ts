// Playwright against the STAGING deployment (M8 T12; docs/M8_design.md 2.2, TST-132, AT-28, AT-31).
// Used only by .github/workflows/staging-e2e-day.yml and nightly.yml, never by ci.yml. There is no
// local web server: the target is APP_BASE_URL (a masked secret of the staging environment) and the
// session comes from the staging test identity (TST-113). Read-only checks of recorded data.
// SEC-110: no trace, screenshot or video is kept (they can hold URLs and page data), the reporter
// prints test titles only, and nothing is uploaded as an artifact.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.APP_BASE_URL;
if (!baseURL) throw new Error("APP_BASE_URL is not set");

export default defineConfig({
  testDir: "./e2e-staging",
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
