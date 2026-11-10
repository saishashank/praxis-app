// INFRA T7: throwaway env files for the pre-deploy check in branch CI (no real service, no repository secret).
//   node scripts/selfhost/predeploy-ci-env.mjs <dir>
// Writes <dir>/web.env, <dir>/jobs.env and an empty <dir>/sqld.env (sqld without JWT checks), with random per-run
// secrets and the check network's sqld addresses. The values exist only in that folder and are not printed.
// predeploy.mjs --ci reads them through PRAXIS_ENV_DIR=<dir>. Names follow deploy/selfhost/env.example.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hex = () => randomBytes(32).toString("hex");
const lines = (o) =>
  `${Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;

/** @returns {{ web: string, jobs: string, sqld: string }} file contents */
export function ciEnv() {
  const shared = {
    PRAXIS_RUNTIME: "selfhost",
    CLOCK_ENABLED: "0",
    APP_BASE_URL: "http://web:3000",
    TURSO_MAIN_URL: "http://main.sqld:8080",
    TURSO_MAIN_TOKEN: hex(),
    PII_HASH_KEY: hex(),
    WORKER_HMAC_SECRET: hex(),
    ACTIONS_HMAC_SECRET: hex(),
    CRON_SECRET: hex(),
    OWNER_EMAIL: "owner@praxis.test",
    EMAIL_PROVIDER: "mock",
    EMAIL_LIVE: "0",
  };
  return {
    web: lines({
      ...shared,
      AUTH_URL: "http://web:3000",
      AUTH_TRUST_HOST: "true",
      AUTH_SECRET: hex(),
      AUTH_GOOGLE_ID: "ci-google-id",
      AUTH_GOOGLE_SECRET: hex(),
      TURSO_AUTH_URL: "http://auth.sqld:8080",
      TURSO_AUTH_TOKEN: hex(),
    }),
    jobs: lines({
      ...shared,
      SQLD_URL: "http://sqld:8080",
      SQLD_ADMIN_URL: "http://sqld:8081",
      SQLD_NS_MODE: "subdomain",
      TURSO_AUTH_URL: "http://auth.sqld:8080",
      TURSO_AUTH_TOKEN: hex(),
    }),
    sqld: "",
  };
}

export function main(argv) {
  const dir = argv[0];
  if (!dir || argv.length !== 1) {
    console.log("usage: predeploy-ci-env.mjs <dir>");
    return 2;
  }
  const e = ciEnv();
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of [
    ["web.env", e.web],
    ["jobs.env", e.jobs],
    ["sqld.env", e.sqld],
  ]) {
    writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  }
  console.log("predeploy-ci-env: wrote web.env, jobs.env and sqld.env");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
