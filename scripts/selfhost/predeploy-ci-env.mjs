// INFRA T7: throwaway env files for the pre-deploy check in branch CI (no real service, no repository secret).
//   node scripts/selfhost/predeploy-ci-env.mjs <dir> [--full <env.example>] [--jwt <keys-dir>] [--refresh-url <url>]
// Writes <dir>/web.env, <dir>/jobs.env and <dir>/sqld.env with random per-run secrets and the check network's sqld
// addresses. The values exist only in that folder and are not printed. predeploy.mjs --ci reads them through
// PRAXIS_ENV_DIR=<dir>. Names follow deploy/selfhost/env.example.
//   default          the names the check stack needs; sqld.env is empty (sqld without JWT checks)
//   --full FILE      every name of every section of env.example is present (the rest empty), so bootstrap.sh's name
//                    check passes on a throwaway box; CLOCK_ENABLED and EMAIL_LIVE stay 0
//   --jwt DIR        sqld verifies tokens: a fresh Ed25519 pair per run; the public key goes to sqld.env, tokens
//                    signed with the private key to TURSO_MAIN_TOKEN, TURSO_AUTH_TOKEN and SQLD_TOKEN; the private
//                    key stays in DIR/jwt-private.pem (never in <dir>, which the stack mounts)
//   --refresh-url U  TURSO_REFRESH_MAIN_URL/TOKEN in jobs.env, for the switch drill (a second local sqld, never Turso)
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { generateKeyPair, mintToken } from "./jwt.mjs";

const hex = () => randomBytes(32).toString("hex");
const lines = (o) =>
  `${Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;

/**
 * @param {{ jwt?: { publicKey: string, token: string }, refreshUrl?: string }} [o]
 * @returns {{ web: string, jobs: string, sqld: string }} file contents
 */
export function ciEnv(o = {}) {
  const tok = () => (o.jwt ? o.jwt.token : hex());
  const shared = {
    PRAXIS_RUNTIME: "selfhost",
    CLOCK_ENABLED: "0",
    APP_BASE_URL: "http://web:3000",
    TURSO_MAIN_URL: "http://main.sqld:8080",
    TURSO_MAIN_TOKEN: tok(),
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
      TURSO_AUTH_TOKEN: tok(),
    }),
    jobs: lines({
      ...shared,
      SQLD_URL: "http://sqld:8080",
      SQLD_ADMIN_URL: "http://sqld:8081",
      SQLD_NS_MODE: "subdomain",
      ...(o.jwt ? { SQLD_TOKEN: o.jwt.token } : {}),
      ...(o.refreshUrl
        ? { TURSO_REFRESH_MAIN_URL: o.refreshUrl, TURSO_REFRESH_MAIN_TOKEN: hex() }
        : {}),
      TURSO_AUTH_URL: "http://auth.sqld:8080",
      TURSO_AUTH_TOKEN: tok(),
    }),
    sqld: o.jwt ? lines({ SQLD_AUTH_JWT_KEY: o.jwt.publicKey }) : "",
  };
}

/** Names of one section of env.example (between its BEGIN and END markers), in file order. */
export function sectionNames(exampleText, section) {
  const names = [];
  let on = false;
  for (const l of String(exampleText).split("\n")) {
    if (l === `# ===== BEGIN ${section} =====`) on = true;
    else if (l === `# ===== END ${section} =====`) on = false;
    else if (on) {
      const m = /^([A-Z][A-Z0-9_]*)=/.exec(l);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/** Every name of the section, in env.example order: the value from `text` when it has one, else empty. */
export function completeSection(exampleText, section, text) {
  const have = new Map();
  for (const l of String(text).split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
    if (m) have.set(m[1], m[2]);
  }
  return lines(
    Object.fromEntries(sectionNames(exampleText, section).map((n) => [n, have.get(n) ?? ""])),
  );
}

export function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? "";
  };
  const full = take("--full");
  const jwtDir = take("--jwt");
  const refreshUrl = take("--refresh-url");
  const dir = args[0];
  if (!dir || args.length !== 1 || full === "" || jwtDir === "" || refreshUrl === "") {
    console.log(
      "usage: predeploy-ci-env.mjs <dir> [--full <env.example>] [--jwt <keys-dir>] [--refresh-url <url>]",
    );
    return 2;
  }
  let jwt;
  if (jwtDir !== undefined) {
    const k = generateKeyPair();
    mkdirSync(jwtDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(jwtDir, "jwt-private.pem"), k.privateKeyPem, { mode: 0o600 });
    writeFileSync(path.join(jwtDir, "jwt-public.txt"), `${k.publicKey}\n`, { mode: 0o600 });
    jwt = { publicKey: k.publicKey, token: mintToken(k.privateKeyPem) };
  }
  const e = ciEnv({ jwt, refreshUrl });
  if (full !== undefined) {
    const example = readFileSync(full, "utf8");
    e.web = completeSection(example, "web.env", e.web);
    e.jobs = completeSection(example, "jobs.env", e.jobs);
    e.sqld = completeSection(example, "sqld.env", e.sqld);
  }
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
