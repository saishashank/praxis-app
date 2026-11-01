// @vitest-environment node
// V1-I9: an explicit PRAXIS_ENV=staging always beats the "holds the production key" inference;
// V1-I6: the backup export client reads integers beyond 2^53 losslessly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authDb, authDbBigint } from "@/lib/db/client";
import { hostLooksStaging, isStagingEnv } from "@/lib/security/envKind";
import { isProduction } from "@/lib/watchdog/handler";
import { appEnvironment } from "@/lib/workerReport/handler";

const PROD = { BACKUP_PUBLIC_KEY: "age1abc" };

describe("isStagingEnv (V1-I9)", () => {
  it.each([
    "https://praxis-app-staging.vercel.app",
    "https://staging.example.com/",
    "https://staging-praxis.example.com",
    "https://app.staging.example.com",
  ])("host %s is staging", (u) => expect(hostLooksStaging(u)).toBe(true));
  it.each([
    undefined,
    "",
    "not a url",
    "https://praxis-app.vercel.app",
    "https://notstaging-ish.com",
    "https://stagingarea.example.com",
    "https://example.com/staging",
  ])("%s is not staging", (u) => expect(hostLooksStaging(u)).toBe(false));
  it("PRAXIS_ENV is case-insensitive; a production-looking host alone is not staging", () => {
    expect(isStagingEnv({ PRAXIS_ENV: "STAGING" })).toBe(true);
    expect(isStagingEnv({ PRAXIS_ENV: "production" })).toBe(false);
    expect(isStagingEnv({ PRAXIS_ENV: "production", APP_BASE_URL: "https://x-staging.test" })).toBe(
      false,
    );
    expect(isStagingEnv({ APP_BASE_URL: "https://praxis.example.com" })).toBe(false);
    expect(isStagingEnv({})).toBe(false);
  });
});

describe("environment derivation honours an explicit staging mark (V1-I9)", () => {
  it("workerReport.appEnvironment", () => {
    expect(appEnvironment(PROD)).toBe("production");
    expect(appEnvironment({ ...PROD, PRAXIS_ENV: "production" })).toBe("production");
    expect(appEnvironment({ ...PROD, PRAXIS_ENV: "staging" })).toBe("staging");
    expect(appEnvironment({ ...PROD, APP_BASE_URL: "https://praxis-app-staging.vercel.app" })).toBe(
      "staging",
    );
    expect(appEnvironment({})).toBe("staging");
  });
  it("watchdog.isProduction", () => {
    expect(isProduction(PROD)).toBe(true);
    expect(isProduction({ ...PROD, PRAXIS_ENV: "staging" })).toBe(false);
    expect(isProduction({ ...PROD, TEST_IDENTITY_SECRET: "b".repeat(64) })).toBe(false);
    expect(isProduction({ ...PROD, APP_BASE_URL: "https://praxis-app-staging.vercel.app" })).toBe(
      false,
    );
    expect(isProduction({ ...PROD, APP_BASE_URL: "https://praxis-app.vercel.app" })).toBe(true);
    expect(isProduction({})).toBe(false);
  });
});

describe("authDbBigint (V1-I6)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praxis-bigint-"));
  afterEach(() => vi.unstubAllEnvs());
  it("reads an INTEGER above 2^53 exactly; the shared number-mode client refuses it", async () => {
    vi.stubEnv("TURSO_AUTH_URL", `file:${path.join(dir, "a.db").split(path.sep).join("/")}`);
    vi.stubEnv("TURSO_AUTH_TOKEN", "");
    const big = authDbBigint();
    await big.execute("CREATE TABLE IF NOT EXISTS t (v INTEGER)");
    await big.execute("DELETE FROM t");
    await big.execute("INSERT INTO t VALUES (9223372036854775807)");
    const r = await big.execute("SELECT v FROM t");
    expect(r.rows[0].v).toBe(9223372036854775807n);
    expect(authDbBigint()).toBe(big); // cached, separate from the number-mode client
    expect(authDb()).not.toBe(big);
    await expect(authDb().execute("SELECT v FROM t")).rejects.toThrow();
    big.close();
    authDb().close();
  });
});
