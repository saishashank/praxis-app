// Runs the OWASP ZAP baseline scan for .github/workflows/zap-baseline.yml (M8 T12;
// docs/M8_design.md 2.3, decisions 7, 37; AT-29, SEC-107, SEC-110).
//   node scripts/ci/zap-run.mjs local     the local production build (throwaway databases and secrets
//                                         generated here), unauthenticated
//   node scripts/ci/zap-run.mjs staging   the staging deployment, as the viewer test identity (TST-113)
// env: ZAP_IMAGE (container reference pinned by digest, required), ZAP_OUT (report folder, default
//      $RUNNER_TEMP/zap). staging also needs APP_BASE_URL and TEST_IDENTITY_SECRET.
// The report (which holds URLs) is written to ZAP_OUT and is read by zap-summary.mjs; it is never
// uploaded. ZAP's own output is discarded (stdio ignored), and this script prints fixed sentences
// only, never a URL, cookie or secret. The session cookie reaches ZAP as one argument of a process
// started without a shell. Exit 0 = a report exists (the verdict is zap-summary's), 2 = it does not.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testLogin } from "../e2e/test-login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const IMAGE_PATTERN = /^ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}$/;
const COOKIE_PAIR = /^(?:__Secure-)?authjs\.session-token=[\w.%~+/=-]+$/;
const PORT = 3100; // threshold-ok: the e2e port, as playwright.config.ts
const HEALTH_WAIT_MS = 300_000; // threshold-ok: the build and start allowance, as playwright.config.ts
const VIEWER = "viewer@praxis.test";

/** The `docker run` arguments. `cookie` is added as a ZAP replacer rule on every request. */
export function dockerArgs({ image, target, outDir, cookie, hostNetwork }) {
  if (!IMAGE_PATTERN.test(image)) throw new Error("the ZAP image must be pinned by digest");
  const args = ["run", "--rm"];
  if (hostNetwork) args.push("--network", "host");
  args.push("-v", `${outDir}:/zap/wrk:rw`, "-u", "zap", image, "zap-baseline.py");
  args.push("-t", target, "-J", "zap.json", "-I");
  if (cookie) {
    if (!COOKIE_PAIR.test(cookie)) throw new Error("unexpected session cookie shape");
    const rule = "replacer.full_list(0)";
    args.push(
      "-z",
      [
        `-config ${rule}.description=session`,
        `-config ${rule}.enabled=true`,
        `-config ${rule}.matchtype=REQ_HEADER`,
        `-config ${rule}.matchstr=Cookie`,
        `-config ${rule}.regex=false`,
        `-config ${rule}.replacement=${cookie}`,
      ].join(" "),
    );
  }
  return args;
}

function prepareOut(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o777); // threshold-ok: the zap user in the container must be able to write the report
}

function scan(args, outDir, run = spawnSync) {
  const r = run("docker", args, { stdio: "ignore" });
  // ZAP exits 1 or 2 for findings; only "no report" is an infrastructure failure.
  return r.error === undefined && existsSync(path.join(outDir, "zap.json"));
}

async function waitForHealth(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function runLocal(outDir, image) {
  const dir = path.join(
    process.env.RUNNER_TEMP ?? tmpdir(),
    `praxis-zap-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  const hex = () => randomBytes(32).toString("hex");
  const fileUrl = (n) => pathToFileURL(path.join(dir, n)).href;
  const target = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    E2E_DIR: dir,
    TURSO_MAIN_URL: fileUrl("main.db"),
    TURSO_AUTH_URL: fileUrl("auth.db"),
    AUTH_SECRET: hex(),
    ACTIONS_HMAC_SECRET: hex(),
    PII_HASH_KEY: hex(),
    TEST_IDENTITY_SECRET: hex(),
    APP_BASE_URL: target,
    OWNER_EMAIL: "owner@praxis.test",
    E2E_SCENARIO: "empty",
  };
  let server;
  try {
    for (const cmd of [
      [process.execPath, ["e2e/prepare-db.mjs"]],
      ["npm", ["run", "build:e2e"]],
    ]) {
      const r = spawnSync(cmd[0], cmd[1], {
        cwd: ROOT,
        env,
        stdio: "ignore",
        shell: cmd[0] === "npm",
      });
      if (r.status !== 0) {
        console.log("the local build could not be prepared");
        return 2;
      }
    }
    server = spawn("npm", ["run", "start:e2e"], { cwd: ROOT, env, stdio: "ignore", shell: true });
    if (!(await waitForHealth(target, Date.now() + HEALTH_WAIT_MS))) {
      console.log("the local app did not start");
      return 2;
    }
    prepareOut(outDir);
    return scan(dockerArgs({ image, target, outDir, hostNetwork: true }), outDir) ? 0 : 2;
  } finally {
    if (server) server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runStaging(outDir, image) {
  const base = process.env.APP_BASE_URL;
  const secret = process.env.TEST_IDENTITY_SECRET;
  if (!base || !secret) {
    console.log("the staging address or the test identity is not configured");
    return 2;
  }
  let cookie;
  try {
    cookie = await testLogin(base, secret, VIEWER);
  } catch {
    console.log("the staging test login failed");
    return 2;
  }
  console.log(`::add-mask::${cookie.split("=").slice(1).join("=")}`);
  prepareOut(outDir);
  return scan(dockerArgs({ image, target: base, outDir, cookie }), outDir) ? 0 : 2;
}

export async function main(argv, env = process.env) {
  const mode = argv[0];
  const image = env.ZAP_IMAGE ?? "";
  if (mode !== "local" && mode !== "staging") {
    console.log("usage: zap-run.mjs local|staging");
    return 2;
  }
  if (!IMAGE_PATTERN.test(image)) {
    console.log("ZAP_IMAGE must be a ghcr.io/zaproxy/zaproxy image pinned by sha256 digest");
    return 2;
  }
  const outDir = env.ZAP_OUT ?? path.join(env.RUNNER_TEMP ?? tmpdir(), "zap");
  const code = mode === "local" ? await runLocal(outDir, image) : await runStaging(outDir, image);
  if (code === 0) console.log("ZAP finished; the report is summarised by the next step");
  else console.log("ZAP produced no report");
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    () => {
      console.log("the ZAP run stopped unexpectedly");
      process.exit(2);
    },
  );
}
