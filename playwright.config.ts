// Playwright E2E + accessibility (TST-126). Runs against a LOCAL production build with two
// throwaway libSQL files and per-run random secrets; no real service and no credential is used.
import { defineConfig, devices } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 3100;
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
};
Object.assign(process.env, env);

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/prepare-db.mjs && npm run build:e2e && npm run start:e2e",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env,
    stdout: "pipe",
  },
});
