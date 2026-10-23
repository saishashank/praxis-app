// Playwright E2E + accessibility (TST-126). Runs against a LOCAL production build with two
// throwaway libSQL files and per-run random secrets; no real service and no credential is used.
import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// E2E_PORT lets a local run avoid a port that is already taken (default 3100, as in CI).
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Config is evaluated in the main process first; workers inherit these values from its env.
const hex = () => randomBytes(32).toString("hex");
const dir =
  process.env.E2E_DIR ?? path.join(tmpdir(), `praxis-e2e-${randomBytes(6).toString("hex")}`);
const fileUrl = (name: string) => pathToFileURL(path.join(dir, name)).href;
const env: Record<string, string> = {
  E2E_DIR: dir,
  TURSO_MAIN_URL: process.env.TURSO_MAIN_URL ?? fileUrl("main.db"),
  TURSO_AUTH_URL: process.env.TURSO_AUTH_URL ?? fileUrl("auth.db"),
  AUTH_SECRET: process.env.AUTH_SECRET ?? hex(),
  ACTIONS_HMAC_SECRET: process.env.ACTIONS_HMAC_SECRET ?? hex(),
  PII_HASH_KEY: process.env.PII_HASH_KEY ?? hex(),
  TEST_IDENTITY_SECRET: process.env.TEST_IDENTITY_SECRET ?? hex(),
  APP_BASE_URL: BASE_URL,
  OWNER_EMAIL: "owner@praxis.test",
  E2E_SCENARIO: process.env.E2E_SCENARIO ?? "empty",
};
Object.assign(process.env, env);

// M7 design section 5: desktop (1280 x 800), phone (360 x 800, touch), and screens (screenshot
// capture for the Opus review, UXN-284; only with E2E_SCREENS=1, so the default CI run is unchanged).
const phone = { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true };
const projects = [
  {
    name: "desktop",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    testIgnore: [/mobile\.spec\.ts/, /screens\.spec\.ts/],
  },
  {
    name: "phone",
    use: { ...devices["Desktop Chrome"], ...phone },
    testMatch: /mobile\.spec\.ts/,
  },
  ...(process.env.E2E_SCREENS
    ? [
        {
          name: "screens",
          use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
          testMatch: /screens\.spec\.ts/,
        },
      ]
    : []),
];

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects,
  webServer: {
    command: `node e2e/prepare-db.mjs && npm run build:e2e && npm run start:e2e -- -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env,
    stdout: "pipe",
  },
});
